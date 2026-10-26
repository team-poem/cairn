/**
 * The discover loop — the only place the agent loops (invariant #3). It observes the page,
 * asks the LLM for the next action, acts, and repeats until done, emitting a Scenario that
 * later replays with no LLM (invariant #4). LLM is behind the LlmClient seam (invariant #5).
 *
 * Module layout: prompt (LLM surface) · decision (Decision→Step + shared execution) ·
 * capture (per-step expect) · grounding (freeze-time assertions). This file owns only the loop.
 */
import { PerceptionObservation } from "../observation.js";
import { policyContext, readPolicyScroll } from "../action-policy.js";
import { withBudget, budgetScope, BudgetExceededError, type BudgetOptions } from "../budget.js";
import { identifyScenario } from "../contract.js";
import { snapshotAppContext, withAppContext, appContextProvenance } from "../app-context.js";
import { errorKindOf } from "../errors.js";
import type { Driver, LlmClient, PageGuidanceProvider, PerceptionAdapter } from "../ports.js";
import { requestPageGuidance, pageGuidanceState, pageGuidanceInvalidation, type PageGuidance } from "../page-guidance.js";
import type { Assertion, Scenario, Step } from "../types.js";
import type { TracePhase, TraceScope } from "../trace.js";
import { discoverSystem, buildPrompt, REFERENCE_REJECTION, PAGE_GUIDANCE_RULES } from "./prompt.js";
import { applyDecision, describeAction, describeAmbiguity, parseDecision } from "./decision.js";
import type { ActionPolicy, Decision } from "./decision.js";
import { assignStepExpects, observeOutcomes, pruneIdleScrolls } from "./capture.js";
import { validateSecrets, missingSecretOf, redactSecrets, slotSecretText } from "../secrets.js";
import type { Secrets } from "../secrets.js";
import type { OutcomeMark } from "./capture.js";
import { deriveAssertions, findUnprovenAction, markObservedBeforeLastMutation, markVacuous, proposeAssertions } from "./grounding.js";

export type { ActionPolicy, Decision, PolicyContext, PolicyVerdict } from "./decision.js";
export { applyDecision, decisionToStep, parseDecision } from "./decision.js";
export { rankElements, renderElements, renderRankedElements } from "./prompt.js";

export interface DiscoverOptions extends BudgetOptions {
  /** Optional host app knowledge, snapshotted once; guidance only, not live evidence. Max 16 KiB UTF-8. */
  appContext?: string;
  driver: Driver;
  llm: LlmClient;
  baseUrl?: string;
  maxSteps?: number;
  onStep?: (decision: Decision, step?: Step) => void;
  /** Abort discovery between steps (a host's Stop button). */
  signal?: AbortSignal;
  /**
   * Allow the freeze to carry LLM-judged `expect` assertions (semantic checks). Off by default:
   * `expect` needs an LlmCritic at replay, so the deterministic critic fails it (invariant #4).
   * When off, only evidence-grounded mechanical assertions are frozen — replay stays LLM-free.
   */
  semanticChecks?: boolean;
  /**
   * URL substrings whose 4xx/5xx is product noise (e.g. analytics), excluded from assertion
   * grounding — mirror of `RunScenarioOptions.benign`, so a product-marked noisy endpoint
   * can't strip `no-failed-requests` from the freeze during discovery.
   */
  benign?: string[];
  /** Gate proposed actions (block destructive controls, cap wandering, stop on a goal). Absent → no
   * gate (every action runs) — behaviour unchanged. */
  policy?: ActionPolicy;
  /** The consumer's locale prefixes — the same list replay judges with. The freeze must decide a
   * step's URL expect under the SAME matching rules replay will pre-check it with, or an expect
   * that looked discriminating at freeze becomes pre-satisfied at replay and the step is skipped. */
  localePrefixes?: readonly string[];
  /** Correct perceived element state for widgets that expose it outside a11y, before the model sees
   * the page (a11y-native perception seam). Absent → the raw snapshot is used, unchanged. */
  perceive?: PerceptionAdapter;
  /** Host advice for each decision observation (spec/core/page-guidance.md). Absent → unchanged.
   * Never reaches assertion proposals, judgment, provenance or a frozen scenario. */
  pageGuidance?: PageGuidanceProvider;
  /** Values for `{name}` placeholders the model types (from the intent, e.g. "log in as {user} / {password}"):
   * the driver gets the value, the freeze keeps the placeholder (#174). */
  secrets?: Secrets;
  /** Per-event trace scope (spec/core/trace.md); absent → no emission. */
  trace?: TraceScope;
  /** Phase stamped on this discovery's events: "discover" normally, "heal" when it IS the
   * outcome-heal re-discovery (the phase says why it ran, the kinds say what ran). */
  tracePhase?: TracePhase;
}

/** Consecutive policy rejections before the loop gives up — past this, the LLM has nothing
 * the policy will allow, and each retry costs a full LLM call for zero steps (#77). */
const MAX_CONSECUTIVE_BLOCKS = 3;

export async function discover(intent: string, opts: DiscoverOptions): Promise<Scenario> {
  try {
    return await withBudget(opts, opts.tracePhase === "heal" ? "outcome-heal" : "discover", (options, scope) =>
      discoverWithinBudget(intent, scope ? { ...options, driver: scope.driver(options.driver), llm: scope.llm(options.llm) } : options));
  } catch (error) {
    if (error instanceof BudgetExceededError && !opts[budgetScope]) opts.trace?.emit({ kind: "budget-exhausted", payload: error.budget });
    throw error;
  }
}

async function discoverWithinBudget(intent: string, opts: DiscoverOptions): Promise<Scenario> {
  validateSecrets(opts.secrets);
  const appContext = snapshotAppContext(opts.appContext, opts.secrets);
  const llm = withAppContext(opts.llm, appContext);
  const { driver, baseUrl, maxSteps = 20, onStep, signal, semanticChecks = false, benign = [], perceive, trace, tracePhase = "discover", localePrefixes, secrets, pageGuidance } = opts;
  const policy = opts.policy?.createRun?.() ?? opts.policy;
  const guidanceGate = (reason: string) => trace?.emit({ kind: "gate", phase: tracePhase, payload: { gate: "page-guidance", reason } });
  const steps: Step[] = [];
  // Per-step outcome marks, index-aligned with `steps` — expects are decided retroactively at
  // freeze time from the COMPLETED evidence (#81), never from a mid-run snapshot that races the
  // step's own in-flight request. `null` = a step the loop doesn't verify (the baseUrl goto).
  const marks: (OutcomeMark | null)[] = [];

  // Emit the freeze: observe pending mutations and short post-response redirects within one
  // budget, then assign expects retroactively and ground assertions. `truncated` marks a step-cap stop.
  const finish = async (truncated: boolean, proposed: Assertion[] = []): Promise<Scenario> => {
    const incomplete = truncated ? policy?.incomplete?.() : undefined;
    if (incomplete) trace?.emit({ kind: "gate", phase: tracePhase,
      payload: { gate: "no-progress", reason: incomplete.diagnostic.code, ...incomplete.diagnostic } });
    // Where the flow's own traffic starts: the first action's mark, or — when nothing acted — the
    // end of the settled entry load, so a landing-page beacon never reads as the flow's own.
    const firstCount =
      marks.find((m): m is OutcomeMark => m !== null)?.requestCount ?? baseline.logic.requests.length;
    const evidence = await observeOutcomes(driver, firstCount, marks, benign);
    // Before expects are assigned: indices shift, and a pruned scroll's (empty) tail folds into
    // the step that follows it. Each prune is a gate firing, not silence — the trace names the
    // original index so a viewer can reconcile it with the `action` events already emitted.
    for (const { index, step } of pruneIdleScrolls(steps, marks, evidence, benign)) {
      trace?.emit({
        kind: "gate",
        phase: tracePhase,
        stepRef: index,
        payload: {
          gate: "idle-scroll",
          action: `scroll ${step.kind === "scroll" ? step.direction ?? "down" : ""}`.trim(),
          reason: "no requests fired and the next target was already present, so replay does not need it",
        },
      });
    }
    assignStepExpects(steps, marks, evidence, { localePrefixes, benign });
    if (opts[budgetScope]) opts[budgetScope].phase = tracePhase === "heal" ? "outcome-assertions" : "assertions";
    const all = [...proposed, ...(await proposeAssertions(llm, intent, evidence, semanticChecks))];
    const grounded = deriveAssertions(all, evidence, semanticChecks, benign, (a, reason) =>
      trace?.emit({
        kind: "gate",
        phase: tracePhase,
        payload: { gate: "grounding", action: JSON.stringify(a), reason },
      }),
    );
    const baselineMarked = markVacuous(grounded, baseline, benign, { localePrefixes });
    // Declare the notation only when this freeze actually used it, so a file without the marker
    // keeps reading `*` as the literal character it was frozen as (spec/core/judgment.md).
    const wrote = (v: string | undefined) => v?.split("/").includes("*") ?? false;
    const wildcards =
      baselineMarked.some((a) => a.kind === "navigated" && wrote(a.to)) ||
      steps.some((step) => wrote(step.expect?.url))
        ? { wildcards: true as const }
        : {};
    const assertions = markObservedBeforeLastMutation(baselineMarked, marks, evidence, {
      localePrefixes, benign, ...wildcards,
    });
    // Record an action the freeze could not express a check for — advisory for now (see
    // spec/core/judgment.md): the freeze carries it and the trace names it, replay does not fail on it.
    const unprovenRequest = findUnprovenAction(evidence, assertions, {
      benign,
      sinceRequest: firstCount,
      pageUrls: marks.map((m) => m?.url),
    });
    const unproven = unprovenRequest ? { unprovenAction: `${unprovenRequest.method} ${unprovenRequest.url}` } : {};
    if (unprovenRequest) {
      trace?.emit({
        kind: "gate",
        phase: tracePhase,
        payload: { gate: "unproven-action", action: unproven.unprovenAction, reason: "no stable URL to check" },
      });
    }
    const scenario: Scenario = truncated
      ? { name: intent, steps, assertions, truncated: true, ...(incomplete ? { truncationReason: incomplete.diagnostic.code } : {}), ...wildcards, ...unproven }
      : { name: intent, steps, assertions, ...wildcards, ...unproven };
    return identifyScenario(scenario, { intent: slotSecretText(intent, secrets), benign, localePrefixes,
      provenance: await appContextProvenance(appContext) });
  };

  // Last-known page url for the prompt/policy (#116) — refreshed from each action's observation,
  // so it can lag by at most one action; no extra observe per turn.
  let currentUrl: string | undefined = undefined;

  if (baseUrl) {
    await driver.goto(baseUrl);
    steps.push({ kind: "goto", url: baseUrl });
    opts[budgetScope]?.recordAction({ step: { kind: "goto", url: baseUrl }, ok: true });
    marks.push(null);
    currentUrl = baseUrl;
  }

  // #137: the starting state, before any flow action — freeze-time vacuity is judged against
  // this, so a check the landing page already satisfies gets flagged as proving nothing.
  await driver.settle();
  const baseline = await driver.observe();

  // Remember what already failed so the LLM stops retrying dead ends (real sites have
  // hover menus, overlays, maintenance pages). ADAPT is the point of the loop (invariant #3).
  // Deduped — a repeated identical failure line is only prompt noise (#77).
  const failures: string[] = [];
  const pushFailure = (line: string): void => {
    if (!failures.includes(line)) failures.push(line);
  };
  let consecutiveBlocks = 0;
  for (let i = 0; i < maxSteps; i++) {
    signal?.throwIfAborted();
    await driver.settle();
    // A guided decision needs this observation's own URL, not the one lagging an action behind.
    const observedUrl = pageGuidance ? (await driver.observe()).execution.finalUrl : undefined;
    const scrollBefore = await readPolicyScroll(policy, driver);
    const raw = await driver.snapshot({ perception: true });
    const scrollAfter = await readPolicyScroll(policy, driver);
    const elements = redactSecrets(perceive ? await perceive(raw.map(e => ({ ...e }))) : raw, secrets);
    if (policy?.needsScrollState) currentUrl = (await driver.observe()).execution.finalUrl ?? currentUrl;
    const ctx = policyContext(elements, currentUrl, scrollBefore, scrollAfter);
    policy?.observe?.(ctx);
    let page: PerceptionObservation;
    try {
      page = new PerceptionObservation(driver, raw, elements, intent, undefined, Boolean(trace));
    } catch (err) {
      if (errorKindOf(err) !== "resolution") throw err;
      // Keep raw page content and rejected references out of the diagnostic stream.
      trace?.emit({
        kind: "gate",
        phase: tracePhase,
        payload: { gate: "perception-binding", reason: "perception binding rejected: invalid or changed element references" },
      });
      pushFailure(`perception binding rejected: ${err instanceof Error ? err.message : String(err)}`);
      continue; // a fresh capture may recover; maxSteps bounds persistent invalid bindings
    }
    // Goal check on the fresh page (#77) — "reached /confirmation" is a page property, not a step one.
    if (policy?.stop?.(steps, ctx)) return finish(false);
    if (policy?.incomplete?.()?.halt) return finish(true);
    const render = page.render;
    const capturedState = pageGuidance ? pageGuidanceState(raw) : undefined;
    const guidance: PageGuidance | undefined = pageGuidance && await requestPageGuidance(pageGuidance, {
      purpose: "discover", page, url: observedUrl, secrets, signal, scope: opts[budgetScope], gate: guidanceGate });
    // The prompt's page line must name the page the guidance was written for.
    if (guidance) currentUrl = observedUrl ?? currentUrl;
    const prompt = buildPrompt(intent, render, steps, failures, currentUrl, page.references, guidance?.text);
    page.tracePrepared(trace, "discover", tracePhase);
    const reply = await llm.complete(prompt, {
      system: discoverSystem(Boolean(page.references)) + (guidance ? PAGE_GUIDANCE_RULES : ""),
    });

    let decision: Decision;
    try {
      decision = parseDecision(reply);
      // A literal secret the model echoed becomes its `{name}` here, before the ambiguity and
      // policy gates, `onStep`, the trace, or execution see the decision (#174): every branch
      // below hands out this object, so it is sanitized once, at the source.
      if (decision.action === "type" && decision.value !== undefined) decision = { ...decision, value: slotSecretText(decision.value, secrets) };
    } catch {
      // A malformed reply must not kill the whole discovery — nudge and retry.
      trace?.emit({
        kind: "gate",
        phase: tracePhase,
        payload: { gate: "parse-retry", reason: "reply was not a single valid JSON action object" },
      });
      pushFailure("your previous reply was not a single valid JSON action object");
      continue;
    }

    try {
      decision = page.bind(decision);
    } catch (err) {
      if (errorKindOf(err) !== "resolution") throw err;
      trace?.emit({
        kind: "gate",
        phase: tracePhase,
        payload: { gate: "reference-binding", reason: "reference binding rejected: invalid, expired or contradictory observation reference" },
      });
      pushFailure(`${REFERENCE_REJECTION}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (guidance) {
      signal?.throwIfAborted();
      const invalidation = await pageGuidanceInvalidation(driver, guidance, capturedState!, decision.ref !== undefined);
      signal?.throwIfAborted();
      if (invalidation) {
        guidanceGate(invalidation);
        pushFailure(`${describeAction(decision)} — not run: the page changed after the observation it was decided on`);
        continue;
      }
    }

    if (decision.action === "done") {
      // The model's own end-of-flow decision is trace-visible too — without it, a stream can't
      // tell "model finished" apart from a policy stop (spec/core/trace.md addendum).
      trace?.emit({
        kind: "action",
        phase: tracePhase,
        payload: { done: true, ok: !policy?.incomplete?.(), intent: decision.reason?.trim() || undefined },
      });
      onStep?.(decision);
      // Checks are authored only by the unguided proposal call.
      if (guidance && decision.assertions?.length) guidanceGate("page guidance: assertions proposed in a guided decision were not used");
      return finish(Boolean(policy?.incomplete?.()), guidance ? [] : decision.assertions ?? []);
    }

    // Ambiguity gate (#127): a duplicated name without nth never reaches the driver — the loop
    // holds the fresh snapshot, so it can name the ambiguity (and the fix) for the re-decision.
    // In core, once, so every consumer's driver gets the principle.
    const ambiguity = describeAmbiguity(decision, elements);
    if (ambiguity) {
      trace?.emit({
        kind: "gate",
        phase: tracePhase,
        payload: { gate: "ambiguity", action: describeAction(decision), reason: ambiguity },
      });
      pushFailure(`${describeAction(decision)} — ${ambiguity}`);
      onStep?.(decision);
      continue;
    }

    try {
      const beforeObs = await driver.observe();
      // Guidance cannot carry a decision onto a page other than the one it was written for.
      if (guidance && beforeObs.execution.finalUrl !== guidance.url) {
        guidanceGate("page guidance expired: the page URL changed after the guided observation");
        pushFailure(`${describeAction(decision)} — not run: the page changed after the observation it was decided on`);
        onStep?.(decision);
        continue;
      }
      currentUrl = beforeObs.execution.finalUrl ?? currentUrl;
      // Policy gate (#77): sees the page (elements + url), runs inside the try so a throwing
      // vet is a recorded rejection, not a lost discovery. A rejected action never executes.
      const verdict = policy?.vet(decision, { ...ctx, url: beforeObs.execution.finalUrl }) ?? {
        ok: true as const,
      };
      if (!verdict.ok) {
        trace?.emit({
          kind: "gate",
          phase: tracePhase,
          payload: { gate: "policy", action: describeAction(decision), reason: verdict.reason, ...(verdict.diagnostic ?? {}) },
        });
        pushFailure(`${describeAction(decision)} — blocked by policy: ${verdict.reason}`);
        onStep?.(decision);
        // Blocked out: the policy keeps rejecting everything the LLM can think of — stop burning
        // LLM calls and freeze what exists as untrusted rather than looping to the cap.
        if (++consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) return finish(true);
        continue;
      }
      consecutiveBlocks = 0;
      const mark: OutcomeMark = {
        url: beforeObs.execution.finalUrl,
        requestCount: beforeObs.logic.requests.length,
        // Only a scroll needs its pre-step snapshot kept: the freeze asks whether the targets after
        // it were already there (#177). Raw answers presence (what the driver locates against); the
        // perceived list, when a hook exists, answers usability (the state it was installed to fix).
        ...(decision.action === "scroll" ? { elements: raw, ...(perceive ? { perceived: elements } : {}) } : {}),
      };
      const step = await applyDecision(driver, decision, secrets);
      // Capture for surgical-heal: intent (heal rationale) now; the grounded per-step
      // post-condition is assigned retroactively in finish() from the completed evidence.
      if (decision.reason?.trim()) step.intent = decision.reason.trim();
      steps.push(step);
      opts[budgetScope]?.recordAction({ step, ok: true });
      marks.push(mark);
      policy?.executed?.(step, ctx);
      trace?.emit({
        kind: "action",
        phase: tracePhase,
        stepRef: steps.length - 1,
        payload: { step, intent: step.intent, ok: true },
      });
      onStep?.(decision, step);
    } catch (err) {
      // A placeholder nobody supplied is the host's wiring: the model cannot route around it, and
      // every further turn would burn an LLM call on the same wall. Stop here, loudly (#174).
      if (err instanceof BudgetExceededError || missingSecretOf(err) !== undefined) throw err;
      trace?.emit({
        kind: "action",
        phase: tracePhase,
        payload: {
          intent: decision.reason?.trim() || undefined,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      pushFailure(`${describeAction(decision)} — ${err instanceof Error ? err.message : String(err)}`);
      onStep?.(decision);
    }
  }

  // Step cap reached without an explicit "done". Ask the policy once more on the final page —
  // a goal reached by the last action is a trusted finish, not a truncation (#77).
  if (policy?.stop || policy?.observe) {
    await driver.settle();
    const before = await readPolicyScroll(policy, driver);
    const raw = await driver.snapshot(policy.observe ? { perception: true } : undefined);
    const after = await readPolicyScroll(policy, driver);
    const elements = policy.observe ? redactSecrets(perceive ? await perceive(raw.map(e => ({ ...e }))) : raw, secrets) : raw;
    try {
      // A final goal check must not trust bindings rejected on an ordinary decision turn.
      new PerceptionObservation(driver, raw, elements, intent);
    } catch (err) {
      if (errorKindOf(err) !== "resolution") throw err;
      trace?.emit({
        kind: "gate",
        phase: tracePhase,
        payload: { gate: "perception-binding", reason: "perception binding rejected: invalid or changed element references" },
      });
      return finish(true);
    }
    const url = policy.needsScrollState ? (await driver.observe()).execution.finalUrl : undefined;
    const ctx = policyContext(elements, url, before, after);
    policy.observe?.(ctx);
    if (policy.stop?.(steps, ctx)) return finish(false);
  }
  return finish(true);
}
