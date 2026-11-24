/**
 * The discover loop — the only place the agent loops (invariant #3). It observes the page,
 * asks the LLM for the next action, acts, and repeats until done, emitting a Scenario that
 * later replays with no LLM (invariant #4). LLM is behind the LlmClient seam (invariant #5).
 *
 * Module layout: prompt (LLM surface) · decision (Decision→Step + shared execution) ·
 * capture (per-step expect) · grounding (freeze-time assertions). This file owns only the loop.
 */
import { decisionReference, PerceptionObservation } from "../observation.js";
import { ActionOutcomeTracker, type ActionOutcomeOptions } from "../action-outcomes.js";
import { readGuidedPage, listedScopeBaseline, scopedClick } from "../guided-click.js";
import { copyGuidanceScope, ScopedGuidanceExpired, type PageGuidanceScope, type GuidanceScopeDiagnostic } from "../guidance-scope.js";
import { policyContext, readPolicyScroll } from "../action-policy.js";
import { withBudget, withWorkflowEntry, budgetScope, BudgetExceededError, type BudgetOptions } from "../budget.js";
import { identifyScenario } from "../contract.js";
import { snapshotAppContext, withAppContext, appContextProvenance } from "../app-context.js";
import { errorKindOf } from "../errors.js";
import type { Driver, LlmClient, PageGuidanceProvider, PerceptionAdapter } from "../ports.js";
import { requestPageGuidance, pageGuidanceState, pageGuidanceInvalidation, pageGuidanceUrlInvalidation, PageGuidanceAttempts, type PageGuidance } from "../page-guidance.js";
import type { Assertion, Evidence, Scenario, Step } from "../types.js";
import type { TracePhase, TraceScope } from "../trace.js";
import { discoverSystem, buildPrompt, REFERENCE_REJECTION, PAGE_GUIDANCE_RULES } from "./prompt.js";
import { executeDecision, describeAction, describeAmbiguity, describeDisallowed, disallowedGate, parseDecision } from "./decision.js";
import type { ActionPolicy, Decision } from "./decision.js";
import { assignStepExpects, observeOutcomes, pruneIdleScrolls } from "./capture.js";
import { validateSecrets, missingSecretOf, redactSecrets, slotSecretText } from "../secrets.js";
import type { Secrets } from "../secrets.js";
import type { OutcomeMark } from "./capture.js";
import { EvidenceCaptureSession, type EvidenceCaptureOptions } from "../evidence-capture.js";
import { deriveAssertions, findUnprovenAction, markObservedBeforeLastMutation, markVacuous, proposeAssertions } from "./grounding.js";
import { DiscoveryTaskRun, taskDecisionGrounded, type DiscoveryTaskPlan, type DiscoveryTaskReport, type DiscoveryTaskStopReason } from "./tasks.js";

export type { ActionPolicy, Decision, PolicyContext, PolicyVerdict } from "./decision.js";
export { applyDecision, decisionToStep, parseDecision } from "./decision.js";
export { rankElements, renderElements, renderRankedElements } from "./prompt.js";

export interface DiscoverOptions extends BudgetOptions {
  evidenceCapture?: EvidenceCaptureOptions;
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
  /** Opt into comparable repeated-click limits and optional outcome reporting. */
  actionOutcomes?: ActionOutcomeOptions;
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
  /** Measure these prerequisites; only a provider reply tagged "declared-scope" uses them. */
  pageGuidanceScope?: PageGuidanceScope;
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

export function discover(intent: string, opts: DiscoverOptions): Promise<Scenario> {
  return withWorkflowEntry(opts, () => discoverEntry(intent, opts));
}

interface TaskSession { run: DiscoveryTaskRun; reason: DiscoveryTaskStopReason }

/** Run the same discovery loop with a host-declared task scope. Progress describes this run, not replay. */
export function discoverWithTasks(intent: string, opts: DiscoverOptions & { taskPlan: DiscoveryTaskPlan }):
Promise<{ scenario: Scenario; progress: DiscoveryTaskReport }> {
  return withWorkflowEntry(opts, async () => {
    if (opts.maxSteps !== undefined && (!Number.isSafeInteger(opts.maxSteps) || opts.maxSteps < 0))
      throw new Error("discoverWithTasks requires a finite, nonnegative integer maxSteps");
    const tasks: TaskSession = { run: new DiscoveryTaskRun(opts.taskPlan), reason: "engine-stopped" };
    const scenario = await discoverEntry(intent, opts, tasks);
    return { scenario, progress: tasks.run.report(tasks.reason) };
  });
}

async function discoverEntry(intent: string, opts: DiscoverOptions, tasks?: TaskSession): Promise<Scenario> {
  try {
    return await withBudget(opts, opts.tracePhase === "heal" ? "outcome-heal" : "discover", (options, scope) =>
      discoverWithinBudget(intent, scope ? { ...options, driver: scope.driver(options.driver), llm: scope.llm(options.llm) } : options, tasks));
  } catch (error) {
    // Without a budget wrapper, failed final/goal observations must still retain caller cancellation.
    if (!(error instanceof BudgetExceededError)) opts.signal?.throwIfAborted();
    if (error instanceof BudgetExceededError && !opts[budgetScope]) opts.trace?.emit({ kind: "budget-exhausted", payload: error.budget });
    throw error;
  }
}

async function discoverWithinBudget(intent: string, opts: DiscoverOptions, tasks?: TaskSession): Promise<Scenario> {
  validateSecrets(opts.secrets);
  const capture = opts.evidenceCapture ? new EvidenceCaptureSession(opts.evidenceCapture,
    opts.tracePhase === "heal" ? "heal" : "discover", opts.secrets) : undefined;
  try {
    return await discoverWithCapture(intent, opts, capture, tasks);
  } finally {
    capture?.finish(opts.signal);
  }
}

async function discoverWithCapture(intent: string, opts: DiscoverOptions, capture?: EvidenceCaptureSession, tasks?: TaskSession): Promise<Scenario> {
  const appContext = snapshotAppContext(opts.appContext, opts.secrets);
  const llm = withAppContext(opts.llm, appContext);
  const { driver, baseUrl, maxSteps = 20, onStep, signal, semanticChecks = false, benign = [], perceive, trace, tracePhase = "discover", localePrefixes, secrets, pageGuidance } = opts;
  const policy = opts.policy?.createRun?.() ?? opts.policy;
  const { actionOutcomes } = opts;
  const outcomes = new ActionOutcomeTracker(actionOutcomes);
  const guidanceAttempts = new PageGuidanceAttempts();
  const scope = pageGuidance && opts.pageGuidanceScope !== undefined ? copyGuidanceScope(opts.pageGuidanceScope) : undefined;
  const check = () => { signal?.throwIfAborted(); opts[budgetScope]?.check(); };
  const guidanceGate = (reason: string, diagnostic?: GuidanceScopeDiagnostic) => trace?.emit({ kind: "gate", phase: tracePhase, payload: { gate: "page-guidance", reason, ...diagnostic } });
  const steps: Step[] = [];
  // Per-step outcome marks, index-aligned with `steps` — expects are decided retroactively at
  // freeze time from the COMPLETED evidence (#81), never from a mid-run snapshot that races the
  // step's own in-flight request. `null` = a step the loop doesn't verify (the baseUrl goto).
  const marks: (OutcomeMark | null)[] = [];
  const closeActionInterval = (evidence: Evidence | undefined): void => {
    const last = marks[marks.length - 1];
    if (actionOutcomes && evidence && last) {
      last.end ??= { url: evidence.execution.finalUrl, requestCount: evidence.logic.requests.length };
    }
  };
  const identify = async (scenario: Scenario) => identifyScenario(scenario, {
    intent: slotSecretText(intent, secrets), benign, localePrefixes, provenance: await appContextProvenance(appContext),
  });

  // Emit the freeze: observe pending mutations and short post-response redirects within one
  // budget, then assign expects retroactively and ground assertions. `truncated` marks a step-cap stop.
  const finish = async (truncated: boolean, proposed: Assertion[] = []): Promise<Scenario> => {
    check();
    const guidanceExpired = truncated && guidanceAttempts.exhausted;
    const incomplete = truncated && !guidanceExpired ? policy?.incomplete?.() : undefined;
    const truncationReason = guidanceExpired ? "page-guidance-expired" : incomplete?.diagnostic.code ??
      (truncated && outcomes.suspect ? "action-no-progress" : undefined);
    if (incomplete) trace?.emit({ kind: "gate", phase: tracePhase,
      payload: { gate: "no-progress", reason: incomplete.diagnostic.code, ...incomplete.diagnostic } });
    // Where the flow's own traffic starts: the first action's mark, or — when nothing acted — the
    // end of the settled entry load, so a landing-page beacon never reads as the flow's own.
    const firstCount =
      marks.find((m): m is OutcomeMark => m !== null)?.requestCount ?? baseline.logic.requests.length;
    const evidence = await observeOutcomes(driver, firstCount, marks, benign);
    check();
    // Before expects are assigned: indices shift, and a pruned scroll's (empty) tail folds into
    // the step that follows it. Each prune is a gate firing, not silence — the trace names the
    // original index so a viewer can reconcile it with the `action` events already emitted.
    // Every dispatched task action was explicitly required, including a scroll that fired no request.
    const pruned = tasks ? [] : pruneIdleScrolls(steps, marks, evidence, benign);
    for (const { index, step } of pruned) {
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
    check();
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
      ? { name: intent, steps, assertions, truncated: true, ...(truncationReason ? { truncationReason } : {}), ...wildcards, ...unproven }
      : { name: intent, steps, assertions, ...wildcards, ...unproven };
    const identified = await identify(scenario);
    check();
    if (guidanceExpired) trace?.emit({ kind: "gate", phase: tracePhase,
      payload: { gate: "page-guidance", ...guidanceAttempts.diagnostic() } });
    if (truncationReason === "action-no-progress") trace?.emit({ kind: "gate", phase: tracePhase,
      payload: { gate: "action-no-progress", code: truncationReason, reason: "repeated clicks without observed progress" } });
    check();
    return identified;
  };

  // Legacy URL for prompts and unguided policy checks (#116); keep its existing update points.
  let currentUrl: string | undefined = undefined;
  // Guided goal checks also retain URLs from observations that reject a decision.
  let guidedPolicyUrl: string | undefined;
  const rememberGuidedPolicyUrl = (url: string | undefined): void => {
    if (pageGuidance) guidedPolicyUrl = url ?? guidedPolicyUrl;
  };

  if (tasks) check();
  if (baseUrl) {
    await driver.goto(baseUrl);
    steps.push({ kind: "goto", url: baseUrl });
    opts[budgetScope]?.recordAction({ step: { kind: "goto", url: baseUrl }, ok: true });
    marks.push(null);
    currentUrl = baseUrl;
    rememberGuidedPolicyUrl(baseUrl);
    if (capture) {
      await capture.after({ step: { kind: "goto", url: baseUrl }, ok: true }, driver, signal);
      signal?.throwIfAborted();
      opts[budgetScope]?.check();
    }
  }

  // #137: the starting state, before any flow action — freeze-time vacuity is judged against
  // this, so a check the landing page already satisfies gets flagged as proving nothing.
  if (tasks) check();
  await driver.settle();
  if (tasks) check();
  const baseline = await driver.observe();
  rememberGuidedPolicyUrl(baseline.execution.finalUrl);

  // Remember what already failed so the LLM stops retrying dead ends (real sites have
  // hover menus, overlays, maintenance pages). ADAPT is the point of the loop (invariant #3).
  // Deduped — a repeated identical failure line is only prompt noise (#77).
  const failures: string[] = [];
  const pushFailure = (line: string): void => {
    if (!failures.includes(line)) failures.push(line);
  };
  // Only a fresh, valid observation can assess a confirmed action. Unknown verification is
  // not executable work. A policy stop still stops immediately, without waiving pending tasks.
  const taskBoundary = (ctx: ReturnType<typeof policyContext>) => {
    if (!tasks) return;
    check();
    tasks.run.observe(ctx);
    check();
    const reason = tasks.run.stopReason();
    if (reason) { tasks.reason = reason; return true; }
    if (!tasks.run.hasPendingWork && !tasks.run.needsAssessment) {
      const incomplete = Boolean(policy?.incomplete?.() || outcomes.suspect || guidanceAttempts.exhausted);
      tasks.reason = incomplete ? "engine-stopped" : "tasks-complete";
      return incomplete;
    }
  };
  const policyStop = () => {
    if (tasks) tasks.reason = "policy-stop";
    return finish(Boolean(tasks));
  };
  // Policy hooks share their own context (including their historical URL fallback). A hook
  // must not rewrite the measured URL or page rows used to authorize or assess a task.
  const policyView = (ctx: ReturnType<typeof policyContext>) => tasks && policy ? structuredClone(ctx) : ctx;
  let consecutiveBlocks = 0;
  for (let i = 0; i < maxSteps; i++) {
    check();
    // A trusted goal may still win on one fresh valid observation, but no further decision
    // request is admitted after the guidance limit. Invalid captures cannot prolong recovery.
    if (guidanceAttempts.exhausted && !policy?.stop) return finish(true);
    await driver.settle();
    // A guided decision needs this observation's own URL, not the one lagging an action behind.
    const entryEvidence = pageGuidance || actionOutcomes || tasks ? await driver.observe() : undefined;
    const observedUrl = entryEvidence?.execution.finalUrl;
    const observedRequests = entryEvidence?.logic.requests.length;
    closeActionInterval(entryEvidence);
    rememberGuidedPolicyUrl(observedUrl);
    const scrollBefore = await readPolicyScroll(policy, driver);
    const { elements: captured, baseline: scopeBaseline } = await readGuidedPage(driver, guidanceAttempts.exhausted ? undefined : scope, Boolean(actionOutcomes));
    // Some adapters reuse their row objects. Keep the task's first match bound to what the
    // model saw, even if the adapter or perception hook updates its own copy while it decides.
    const raw = tasks ? structuredClone(captured) : captured;
    const scrollAfter = await readPolicyScroll(policy, driver);
    const perceived = perceive ? await perceive(tasks ? structuredClone(raw) : raw.map(e => ({ ...e }))) : raw;
    const elements = redactSecrets(tasks && perceive ? structuredClone(perceived) : perceived, secrets);
    // Never hand assess() the URL of one document and the rows of another.
    if (tasks) {
      const afterUrl = (await driver.observe()).execution.finalUrl;
      check();
      rememberGuidedPolicyUrl(afterUrl);
      if (afterUrl !== observedUrl) continue;
    }
    if (policy?.needsScrollState) {
      const scrollUrl = (await driver.observe()).execution.finalUrl;
      rememberGuidedPolicyUrl(scrollUrl);
      currentUrl = scrollUrl ?? currentUrl;
      if (tasks && scrollUrl !== observedUrl) continue;
    }
    const policyUrl = pageGuidance ? guidedPolicyUrl : actionOutcomes && entryEvidence && !policy?.needsScrollState
      ? observedUrl : currentUrl;
    const ctx = policyView(policyContext(elements, policyUrl, scrollBefore, scrollAfter));
    const taskCtx = tasks ? policyContext(elements, observedUrl, scrollBefore, scrollAfter) : undefined;
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
      if (guidanceAttempts.exhausted) return finish(true);
      continue; // a fresh capture may recover; maxSteps bounds persistent invalid bindings
    }
    if (actionOutcomes) check();
    // Passive discovery compares rows. A silent guidance provider must not change the prompt
    // merely because it needed a URL read that the unguided path would not have made.
    const frame = outcomes.capture(perceive ? redactSecrets(raw, secrets) : elements,
      actionOutcomes ? observedUrl : undefined, actionOutcomes ? observedRequests : undefined,
      perceive ? elements : undefined);
    outcomes.observe(frame);
    if (actionOutcomes) check();
    const taskEnd = taskCtx && taskBoundary(taskCtx);
    if (taskEnd !== undefined) return finish(taskEnd);
    // Goal check on the fresh page (#77) — "reached /confirmation" is a page property, not a step one.
    if (policy?.stop?.(steps, ctx)) return policyStop();
    if (guidanceAttempts.exhausted) return finish(true);
    if (policy?.incomplete?.()?.halt) return finish(true);
    if (outcomes.halt) return finish(true);
    const render = page.listing;
    const listedScope = listedScopeBaseline(scope, scopeBaseline, page);
    const capturedState = pageGuidance ? pageGuidanceState(raw) : undefined;
    const guidance: PageGuidance | undefined = pageGuidance && await requestPageGuidance(pageGuidance, {
      purpose: "discover", page, url: observedUrl, secrets, signal, scope: opts[budgetScope], gate: guidanceGate });
    if (guidance) {
      const invalidation = await pageGuidanceUrlInvalidation(driver, guidance, signal, rememberGuidedPolicyUrl);
      check();
      if (invalidation) {
        guidanceAttempts.expired();
        guidanceGate(invalidation);
        continue;
      }
    }
    const recovery = guidanceAttempts.recovery(page.hasReferences);
    // A retry uses this capture's URL even if the provider no longer offers advice.
    // A missing URL stays unknown; policy checks retain their own last known URL.
    if (guidance || recovery) currentUrl = observedUrl;
    const prompt = buildPrompt(intent, render, steps, recovery ? [...failures, recovery] : failures, tasks ? observedUrl : currentUrl,
      page.hasReferences, guidance?.text, outcomes.feedback, tasks?.run.prompt(text => slotSecretText(text, secrets)));
    page.tracePrepared(trace, "discover", tracePhase);
    if (actionOutcomes || tasks) check();
    outcomes.admitDecision();
    const reply = await llm.complete(prompt, {
      system: discoverSystem(page.hasReferences) + (guidance ? PAGE_GUIDANCE_RULES : ""),
    });
    if (tasks) check();

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

    const scoped = scopedClick(driver, scope, listedScope, guidance, decision, check, signal, rememberGuidedPolicyUrl, Boolean(tasks));
    if (guidance) {
      signal?.throwIfAborted();
      const invalidation = scoped ? await pageGuidanceUrlInvalidation(driver, guidance, signal, rememberGuidedPolicyUrl)
        : await pageGuidanceInvalidation(driver, guidance, capturedState!, decision.ref !== undefined, signal, rememberGuidedPolicyUrl, Boolean(actionOutcomes));
      check();
      if (invalidation) {
        guidanceAttempts.expired();
        guidanceGate(invalidation);
        pushFailure(`${describeAction(decision)} — not run: the page changed after the observation it was decided on`);
        continue;
      }
      if (scoped?.baselineError) {
        const error = new ScopedGuidanceExpired(scoped.baselineError);
        guidanceAttempts.expired();
        guidanceGate(error.message, error.diagnostic);
        pushFailure(error.message);
        continue;
      }
    }

    if (decision.action === "done") {
      const incomplete = Boolean(policy?.incomplete?.() || outcomes.suspect);
      const canContinue = tasks?.run.canContinueAfterDone();
      // The model's own end-of-flow decision is trace-visible too — without it, a stream can't
      // tell "model finished" apart from a policy stop (spec/core/trace.md addendum).
      trace?.emit({
        kind: "action",
        phase: tracePhase,
        payload: { done: true, ok: !incomplete && !tasks, intent: decision.reason?.trim() || undefined },
      });
      onStep?.(decision);
      // Checks are authored only by the unguided proposal call.
      if (guidance && decision.assertions?.length) guidanceGate("page guidance: assertions proposed in a guided decision were not used");
      if (tasks) {
        if (!incomplete && canContinue) continue; // no assertions from this premature done
        tasks.reason = incomplete ? "engine-stopped" : "early-done-limit";
        return finish(true);
      }
      return finish(incomplete, guidance ? [] : decision.assertions ?? []);
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

    // Measured eligibility: an explicitly disallowed action never reaches the driver, and the next
    // decision is the model's own. Counts with policy blocks so a loop that keeps choosing it stops.
    if (page.disallows(decision)) {
      trace?.emit({ kind: "gate", phase: tracePhase, payload: disallowedGate(decision) });
      pushFailure(describeDisallowed(decision));
      onStep?.(decision);
      if (++consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) return finish(true);
      continue;
    }

    let completedStep: Step | undefined;
    let taskId: string | undefined;
    let callingTaskHook = false;
    // No input has been attempted yet. A scoped observation failure is an execution
    // error; it must not look like an expired decision or an unacknowledged click.
    const scopedBefore = scoped ? await driver.observe() : undefined;
    let executingScope: typeof scoped;
    let expiredAtInput = false;
    let policyUrlExpired = false;
    let taskExpired = false;
    let vetting = false;
    try {
      // When nobody needs a pre-vet URL, move the usual pre-action read to just
      // before execution. The decision's own observation belongs to its listing.
      const beforeObs = scopedBefore ?? (actionOutcomes && !policy && !guidance ? entryEvidence! : await driver.observe());
      check();
      rememberGuidedPolicyUrl(beforeObs.execution.finalUrl);
      // Guidance cannot carry a decision onto a page other than the one it was written for.
      if (guidance && beforeObs.execution.finalUrl !== guidance.url) {
        guidanceAttempts.expired();
        guidanceGate("page guidance expired: the page URL changed after the guided observation");
        pushFailure(`${describeAction(decision)} — not run: the page changed after the observation it was decided on`);
        onStep?.(decision);
        continue;
      }
      currentUrl = beforeObs.execution.finalUrl ?? currentUrl;
      // Policy gate (#77): sees the page (elements + url), runs inside the try so a throwing
      // vet is a recorded rejection, not a lost discovery. A rejected action never executes.
      vetting = true;
      const verdict = policy?.vet(decision, { ...ctx, url: beforeObs.execution.finalUrl }) ?? {
        ok: true as const,
      };
      vetting = false;
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
      const grounding = tasks && { boundRef: decisionReference(driver, decision), hasRefPort: Boolean(driver.locateRef),
        expectedRole: decision.role ?? raw.find(e => e.name === decision.text)?.role,
        requiresExact: Boolean(driver.snapshotForTask), scoped: Boolean(scoped) };
      if (tasks && grounding && taskCtx) {
        check();
        // A task label cannot authorize a guessed URL or bypass per-ref eligibility.
        if (observedUrl === beforeObs.execution.finalUrl && taskDecisionGrounded(decision, page.listed, raw, !perceive, grounding)) {
          callingTaskHook = true;
          taskId = tasks.run.authorize(decision, taskCtx);
          callingTaskHook = false;
        }
        if (!taskId) {
          trace?.emit({ kind: "gate", phase: tracePhase, payload: { gate: "policy", reason: "action not authorized by the discovery task plan" } });
          pushFailure("Action not run. Choose an eligible pending task from the current observation; use its ref when listed.");
          onStep?.(decision);
          continue;
        }
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
      let dispatchFrame = frame;
      const options = { perception: true, ...(actionOutcomes ? { actionOutcomes: true } : {}) };
      let taskScrollBefore: Awaited<ReturnType<typeof readPolicyScroll>>;
      const authorizeLive = async (rows: typeof raw) => {
        if (!tasks || !grounding) return;
        const ownedRows = structuredClone(rows);
        const after = await readPolicyScroll(policy, driver);
        callingTaskHook = Boolean(perceive);
        const corrected = perceive ? structuredClone(await perceive(structuredClone(ownedRows))) : ownedRows;
        callingTaskHook = false;
        const perceived = redactSecrets(corrected, secrets);
        const evidence = await driver.observe();
        const url = evidence.execution.finalUrl;
        check();
        rememberGuidedPolicyUrl(url);
        const expire = (): never => { taskExpired = true; throw new Error("task decision expired before input"); };
        if (url !== observedUrl) expire();
        const listing = new PerceptionObservation(driver, ownedRows, perceived, intent, undefined, false, false);
        if (!taskDecisionGrounded(decision, listing.listed, ownedRows, !perceive, grounding)) expire();
        callingTaskHook = true;
        const liveTask = tasks.run.authorize(decision, policyContext(perceived, url, taskScrollBefore, after));
        callingTaskHook = false;
        if (liveTask !== taskId) expire();
        check();
        mark.url = url;
        mark.requestCount = evidence.logic.requests.length;
        dispatchFrame = outcomes.atDispatch(frame, url, mark.requestCount);
      };
      const beforeExecute = actionOutcomes || tasks ? async () => {
        check();
        const evidence = await driver.observe();
        check();
        const url = evidence.execution.finalUrl;
        rememberGuidedPolicyUrl(url);
        currentUrl = url ?? currentUrl;
        if (guidance && url !== guidance.url) {
          expiredAtInput = true;
          throw new Error("page guidance expired before input");
        }
        if ((policy || tasks) && url !== beforeObs.execution.finalUrl) {
          policyUrlExpired = true;
          throw new Error("policy decision expired before input: page URL changed");
        }
        mark.url = url;
        mark.requestCount = evidence.logic.requests.length;
        dispatchFrame = outcomes.atDispatch(frame, url, mark.requestCount);
        if (tasks) {
          taskScrollBefore = await readPolicyScroll(policy, driver);
          // A scoped receipt supplies its own live target and prerequisite capture.
          if (!scoped) await authorizeLive(await (driver.snapshotForTask ? driver.snapshotForTask(options) : driver.snapshot(options)));
        }
      } : undefined;
      check();
      executingScope = scoped;
      outcomes.arm(driver, decision, check, Boolean(tasks));
      let step: Step, identity: string | undefined;
      try {
        const validate = scoped && tasks ? () => scoped.validate(authorizeLive, options) : scoped?.validate;
        // A legacy named task was authorized for this exact descriptor. Its locate()
        // may add a selector or structural fallback for a different node. Neither
        // dispatch nor freeze that broader locator.
        const exactTaskTarget = grounding && !scoped && decision.ref === undefined && decision.text
          ? { text: decision.text, role: grounding.expectedRole,
            ...(decision.nth !== undefined ? {nth: decision.nth} : {}) } : undefined;
        step = await executeDecision(driver, decision, secrets, validate, outcomes.beforeDriverInput, beforeExecute,
          tasks ? {exactTarget: exactTaskTarget, observedUrl} : undefined);
      } finally {
        identity = outcomes.take(driver, decision);
      }
      executingScope = undefined;
      outcomes.executed(step, beforeExecute ? dispatchFrame : outcomes.atDispatch(frame, mark.url, mark.requestCount), identity, steps.length);
      // A returned Step ran successfully; record it before propagating a concurrent stop.
      guidanceAttempts.executed();
      // Capture for surgical-heal: intent (heal rationale) now; the grounded per-step
      // post-condition is assigned retroactively in finish() from the completed evidence.
      if (decision.reason?.trim()) step.intent = decision.reason.trim();
      completedStep = step;
      steps.push(step);
      if (tasks && taskId) tasks.run.executed(taskId, step);
      opts[budgetScope]?.recordAction({ step, ok: true });
      marks.push(mark);
      policy?.executed?.(step, ctx);
      trace?.emit({
        kind: "action",
        phase: tracePhase,
        stepRef: steps.length - 1,
        payload: { step, intent: step.intent, ok: true },
      });
      if (!capture) onStep?.(decision, step);
    } catch (err) {
      check();
      // A placeholder nobody supplied is the host's wiring: the model cannot route around it, and
      // every further turn would burn an LLM call on the same wall. Stop here, loudly (#174).
      if (err instanceof BudgetExceededError || missingSecretOf(err) !== undefined) throw err;
      if (callingTaskHook || (tasks && completedStep)) throw err; // host error, not a decision to retry
      if (!vetting && (actionOutcomes || tasks) && (errorKindOf(err) === "transport" || (err instanceof Error && err.name === "AbortError"))) throw err;
      if (taskExpired) {
        trace?.emit({ kind: "gate", phase: tracePhase, payload: { gate: "policy", reason: "discovery task no longer authorized on the current observation" } });
        pushFailure("Action not run. The observation no longer authorizes the same task; decide on the current page.");
        onStep?.(decision);
        continue;
      }
      if (policyUrlExpired) {
        trace?.emit({ kind: "gate", phase: tracePhase, payload: { gate: "policy", reason: "the page URL changed after policy approval" } });
        pushFailure("action not run: the page URL changed after policy approval; decide on the current page");
        onStep?.(decision);
        continue;
      }
      if (expiredAtInput) {
        guidanceAttempts.expired();
        guidanceGate("page guidance expired: the page URL changed after the guided observation");
        pushFailure(`${describeAction(decision)} — not run: the page changed after the observation it was decided on`);
        onStep?.(decision);
        continue;
      }
      if (outcomes.blocked(err)) {
        trace?.emit({ kind: "gate", phase: tracePhase, payload: { gate: "action-no-progress", reason: "repeated click blocked before input" } });
        onStep?.(decision);
        continue;
      }
      if (executingScope) {
        const rejected = executingScope.failure(err);
        if (!rejected) throw err;
        if ("code" in rejected) {
          // finish() would read the post-click page and assign its effects to the
          // last confirmed step. Only return what was recorded before this click.
          capture?.invalidate();
          if (tasks && taskId) { tasks.reason = "dispatch-uncertain"; tasks.run.uncertain(taskId); }
          const partial = await identify({ name: intent, steps, assertions: [], truncated: true, truncationReason: rejected.code });
          check();
          trace?.emit({ kind: "gate", phase: tracePhase, payload: { gate: "page-guidance", ...rejected } });
          check();
          return partial;
        }
        guidanceAttempts.expired();
        guidanceGate(rejected.reason, rejected.diagnostic);
        pushFailure(rejected.reason);
        continue;
      }
      if (outcomes.dispatchUncertain) {
        capture?.invalidate();
        const code = outcomes.dispatchUncertain;
        if (tasks && taskId) { tasks.reason = "dispatch-uncertain"; tasks.run.uncertain(taskId); }
        const partial = await identify({ name: intent, steps, assertions: [], truncated: true, truncationReason: code });
        check();
        trace?.emit({ kind: "gate", phase: tracePhase, payload: { gate: "action-no-progress", code,
          reason: "the driver did not confirm the input; it was not retried" } });
        check();
        return partial;
      }
      capture?.invalidate();
      completedStep = undefined;
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
    // Capture failure cannot enter the action retry catch. Cancellation/budget remains terminal.
    if (capture && completedStep) {
      // Even after cancellation, retain the completed path; after() admits no reads on an aborted signal.
      await capture.after({ step: completedStep, ok: true }, driver, signal);
      onStep?.(decision, completedStep);
    }
    check();
  }

  // Step cap reached without an explicit "done". Ask the policy once more on the final page —
  // a goal reached by the last action is a trusted finish, not a truncation (#77).
  if (tasks) tasks.reason = "step-limit";
  if (tasks?.run.needsAssessment || policy?.stop || policy?.observe || (actionOutcomes && (outcomes.hasPending || outcomes.suspect))) {
    check();
    await driver.settle();
    const taskUrl = tasks ? (await driver.observe()).execution.finalUrl : undefined;
    const before = await readPolicyScroll(policy, driver);
    // At the guidance bound, a stop-only policy needs the same corrected, validated view as
    // an ordinary decision turn. Keep the legacy capture mode for unrelated step-cap stops.
    const usePerception = Boolean(policy?.observe || guidanceAttempts.exhausted || actionOutcomes || tasks);
    const raw = await driver.snapshot(usePerception ? { perception: true, ...(actionOutcomes ? { actionOutcomes: true } : {}) } : undefined);
    const after = await readPolicyScroll(policy, driver);
    const elements = usePerception ? redactSecrets(perceive ? await perceive(raw.map(e => ({ ...e }))) : raw, secrets) : raw;
    check();
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
      if (actionOutcomes && outcomes.hasPending) {
        const evidence = await driver.observe();
        check();
        closeActionInterval(evidence);
        outcomes.observe(outcomes.capture([], evidence.execution.finalUrl, evidence.logic.requests.length));
      }
      return finish(true);
    }
    const guidedGoal = Boolean(pageGuidance && guidanceAttempts.exhausted);
    const policyNeedsEvidence = policy?.needsScrollState || guidedGoal || (actionOutcomes && (outcomes.hasPending || outcomes.suspect));
    const evidence = policyNeedsEvidence || tasks ? await driver.observe() : undefined;
    const observedUrl = evidence?.execution.finalUrl;
    check();
    if (tasks && observedUrl !== taskUrl) return finish(true);
    closeActionInterval(evidence);
    if (actionOutcomes) outcomes.observe(outcomes.capture(perceive ? redactSecrets(raw, secrets) : elements, observedUrl,
      evidence?.logic.requests.length, perceive ? elements : undefined));
    check();
    rememberGuidedPolicyUrl(observedUrl);
    // Only the guidance-limit check uses retained evidence; ordinary step caps keep the raw URL.
    const ctx = policyView(policyContext(elements, guidedGoal ? guidedPolicyUrl : policyNeedsEvidence ? observedUrl : undefined, before, after));
    policy?.observe?.(ctx);
    const taskEnd = tasks && taskBoundary(policyContext(elements, observedUrl, before, after));
    if (taskEnd !== undefined) return finish(taskEnd);
    if (policy?.stop?.(steps, ctx)) return policyStop();
  }
  return finish(true);
}
