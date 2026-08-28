/**
 * The discover loop — the only place the agent loops (invariant #3). It observes the page,
 * asks the LLM for the next action, acts, and repeats until done, emitting a Scenario that
 * later replays with no LLM (invariant #4). LLM is behind the LlmClient seam (invariant #5).
 *
 * Module layout: prompt (LLM surface) · decision (Decision→Step + shared execution) ·
 * capture (per-step expect) · grounding (freeze-time assertions). This file owns only the loop.
 */
import type { Driver, LlmClient, PerceptionAdapter } from "../ports.js";
import type { Assertion, Scenario, Step } from "../types.js";
import type { TracePhase, TraceScope } from "../trace.js";
import { SYSTEM, buildPrompt, renderRankedElements } from "./prompt.js";
import { applyDecision, describeAction, describeAmbiguity, parseDecision } from "./decision.js";
import type { ActionPolicy, Decision } from "./decision.js";
import { assignStepExpects, observeOutcomes } from "./capture.js";
import type { OutcomeMark } from "./capture.js";
import { deriveAssertions, hasUnprovenAction, markVacuous, proposeAssertions } from "./grounding.js";

export type { ActionPolicy, Decision, PolicyContext, PolicyVerdict } from "./decision.js";
export { applyDecision, decisionToStep, parseDecision } from "./decision.js";
export { rankElements, renderElements, renderRankedElements } from "./prompt.js";

export interface DiscoverOptions {
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
  const { driver, llm, baseUrl, maxSteps = 20, onStep, signal, semanticChecks = false, benign = [], policy, perceive, trace, tracePhase = "discover", localePrefixes } = opts;
  const steps: Step[] = [];
  // Per-step outcome marks, index-aligned with `steps` — expects are decided retroactively at
  // freeze time from the COMPLETED evidence (#81), never from a mid-run snapshot that races the
  // step's own in-flight request. `null` = a step the loop doesn't verify (the baseUrl goto).
  const marks: (OutcomeMark | null)[] = [];

  // Emit the freeze: wait out any still-in-flight mutation, assign per-step expects retroactively,
  // then propose+ground assertions. `truncated` marks a step-cap stop.
  const finish = async (truncated: boolean, proposed: Assertion[] = []): Promise<Scenario> => {
    const firstCount = marks.find((m): m is OutcomeMark => m !== null)?.requestCount ?? 0;
    const evidence = await observeOutcomes(driver, firstCount);
    assignStepExpects(steps, marks, evidence, { localePrefixes });
    const all = [...proposed, ...(await proposeAssertions(llm, intent, evidence, semanticChecks))];
    const grounded = deriveAssertions(all, evidence, semanticChecks, benign, (a, reason) =>
      trace?.emit({
        kind: "gate",
        phase: tracePhase,
        payload: { gate: "grounding", action: JSON.stringify(a), reason },
      }),
    );
    const assertions = markVacuous(grounded, baseline, benign, { localePrefixes });
    // Declare the notation only when this freeze actually used it, so a file without the marker
    // keeps reading `*` as the literal character it was frozen as (spec/core/judgment.md).
    const wrote = (v: string | undefined) => v?.split("/").includes("*") ?? false;
    const wildcards =
      assertions.some((a) => a.kind === "navigated" && wrote(a.to)) ||
      steps.some((step) => wrote(step.expect?.url))
        ? { wildcards: true as const }
        : {};
    // Record an action the freeze could not express a check for, so replay fails closed on it
    // instead of passing on the assertions that survived (spec/core/judgment.md).
    const unproven = hasUnprovenAction(evidence, assertions, benign, firstCount)
      ? { unprovenAction: true as const }
      : {};
    return truncated
      ? { name: intent, steps, assertions, truncated: true, ...wildcards, ...unproven }
      : { name: intent, steps, assertions, ...wildcards, ...unproven };
  };

  // Last-known page url for the prompt/policy (#116) — refreshed from each action's observation,
  // so it can lag by at most one action; no extra observe per turn.
  let currentUrl: string | undefined = undefined;

  if (baseUrl) {
    await driver.goto(baseUrl);
    steps.push({ kind: "goto", url: baseUrl });
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
  let prevRender = "";
  let consecutiveBlocks = 0;
  for (let i = 0; i < maxSteps; i++) {
    signal?.throwIfAborted();
    await driver.settle();
    const raw = await driver.snapshot();
    const elements = perceive ? await perceive(raw) : raw;
    // Goal check on the fresh page (#77) — "reached /confirmation" is a page property, not a step one.
    if (policy?.stop?.(steps, { elements, url: currentUrl })) return finish(false);
    const render = renderRankedElements(elements, intent);
    const reply = await llm.complete(buildPrompt(intent, render, prevRender, steps, failures, currentUrl), {
      system: SYSTEM,
    });
    prevRender = render;

    let decision: Decision;
    try {
      decision = parseDecision(reply);
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

    if (decision.action === "done") {
      // The model's own end-of-flow decision is trace-visible too — without it, a stream can't
      // tell "model finished" apart from a policy stop (spec/core/trace.md addendum).
      trace?.emit({
        kind: "action",
        phase: tracePhase,
        payload: { done: true, ok: true, intent: decision.reason?.trim() || undefined },
      });
      onStep?.(decision);
      return finish(false, decision.assertions ?? []);
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
      currentUrl = beforeObs.execution.finalUrl ?? currentUrl;
      // Policy gate (#77): sees the page (elements + url), runs inside the try so a throwing
      // vet is a recorded rejection, not a lost discovery. A rejected action never executes.
      const verdict = policy?.vet(decision, { elements, url: beforeObs.execution.finalUrl }) ?? {
        ok: true as const,
      };
      if (!verdict.ok) {
        trace?.emit({
          kind: "gate",
          phase: tracePhase,
          payload: { gate: "policy", action: describeAction(decision), reason: verdict.reason },
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
      };
      const step = await applyDecision(driver, decision);
      // Capture for surgical-heal: intent (heal rationale) now; the grounded per-step
      // post-condition is assigned retroactively in finish() from the completed evidence.
      if (decision.reason?.trim()) step.intent = decision.reason.trim();
      steps.push(step);
      marks.push(mark);
      trace?.emit({
        kind: "action",
        phase: tracePhase,
        stepRef: steps.length - 1,
        payload: { step, intent: step.intent, ok: true },
      });
      onStep?.(decision, step);
    } catch (err) {
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
  if (policy?.stop) {
    await driver.settle();
    if (policy.stop(steps, { elements: await driver.snapshot() })) return finish(false);
  }
  return finish(true);
}
