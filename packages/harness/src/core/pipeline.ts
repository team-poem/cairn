/**
 * The execution body: Context → Plan → Execute → Judge → Report. Every variable behavior
 * is injected (invariant #2); with a fixed-scenario Planner + deterministic Critic, no LLM
 * runs (invariant #4).
 */
import type { CustomAction, Driver, Harness, StepHandler, StepHealer } from "./ports.js";
import type { AssertionResult, Evidence, ExecutedAction, Result, RunUsage, Step, StepProgress, Verdict, FailureClass } from "./types.js";
import { errorKindOf, stepError } from "./errors.js";
import { conditionMet, defaultStepHandlers, pollCondition } from "./steps.js";
import type { UrlMatchOptions } from "./steps.js";
import { assertionPayload } from "./trace.js";
import type { TraceScope } from "./trace.js";

/** Default per-step post-condition readiness window: after a step runs, its `expect` is *waited for*
 * (polled) up to this long before it counts as diverged — so an async effect (a submit's request
 * landing, a deferred redirect/re-render) is caught instead of raced. Deterministic; no LLM
 * (invariant #4). Tunable via `RunHarnessOptions.expectTimeoutMs`. */
const DEFAULT_EXPECT_TIMEOUT_MS = 2_000;

/**
 * Seams a host (CLI, desktop app, CI) plugs into — the engine emits/accepts, the host
 * decides what to do. `onStep` for a live timeline, `captureScreenshots` for visual
 * replay, `signal` for a Stop button, `actions` for product-defined interactions. None of
 * these put UI in the engine.
 */
export interface RunHarnessOptions {
  signal?: AbortSignal;
  onStep?: (progress: StepProgress) => void;
  captureScreenshots?: boolean;
  /** Product-defined interactions for `{ kind: "custom", name }` steps, registered by name. */
  actions?: Record<string, CustomAction>;
  /** Replace the Execute-stage dispatch chain entirely (advanced); defaults to built-ins + `actions`. */
  stepHandlers?: StepHandler[];
  /** Repair a step whose `expect` fails (surgical self-heal); absent → a diverged step just fails. */
  stepHealer?: StepHealer;
  /** How long a step's `expect` is polled (readiness) before it counts as diverged. Default 2000ms. */
  expectTimeoutMs?: number;
  /** Snapshot of the run's LLM usage, taken after Judge and attached as `result.usage` — so every
   * report carries its own cost proof (a clean replay shows `llmCalls: 0`). */
  usage?: () => RunUsage;
  /** First-path-segment prefixes URL matching may strip as locales (fallback only, #86). Which
   * segments are locales is an app trait the consumer declares — the engine default is a small
   * conservative list (`DEFAULT_LOCALE_PREFIXES`); override it when the app serves other locales
   * or has real routes that look like locales (`/my`, `/tv`). `[]` disables stripping. */
  localePrefixes?: readonly string[];
  /** Per-event trace scope (spec/core/trace.md) — `step`/`assertion`/`heal` kinds; absent → no emission. */
  trace?: TraceScope;
}

/** Route one step to the first handler that supports it; record success/failure either way. */
async function executeStep(handlers: StepHandler[], step: Step, driver: Driver): Promise<ExecutedAction> {
  try {
    const handler = handlers.find((h) => h.supports(step));
    if (!handler) throw stepError("handler", `no step handler for kind "${step.kind}"`);
    await handler.execute(step, driver);
    return { step, ok: true };
  } catch (err) {
    const errorKind = errorKindOf(err);
    return { step, ok: false, error: err instanceof Error ? err.message : String(err), ...(errorKind ? { errorKind } : {}) };
  }
}

/**
 * Run a step with per-step `expect` verification (spec/core/surgical-heal.md): skip if it already
 * holds (safe idempotency — gated on `expect`, so never a false pass), else execute and require it
 * to hold afterwards (catches a step that ran but didn't reach its outcome). Deterministic; a
 * divergence goes to `healer` when one is supplied, otherwise the step fails.
 */
async function runStep(
  handlers: StepHandler[],
  step: Step,
  driver: Driver,
  index: number,
  expectTimeoutMs: number,
  urlMatch: UrlMatchOptions,
  healer?: StepHealer,
  trace?: TraceScope,
): Promise<ExecutedAction> {
  // A `requestStatus` expect is event evidence over the run's CUMULATIVE request log, not page
  // state: an idempotency pre-check would be satisfied by an earlier step's (or page-load's)
  // matching request and silently skip this step. Pre-check only state-like conditions, and gate
  // request matching to requests observed after this step started (watermark).
  // An `expect` with no field set (`{}`) names no condition: treat it as absent, so it can
  // neither pre-satisfy the skip nor count as a post-condition (fail closed, #69/#137).
  const expect = step.expect && Object.values(step.expect).some((v) => v !== undefined) ? step.expect : undefined;
  if (expect && expect.requestStatus === undefined && (await conditionMet(driver, expect, 0, urlMatch))) {
    // Already satisfied — safe skip, but never a SILENT one: the marker keeps a wrongly
    // pre-satisfied expect (the #56→#86/#87/#96 failure class) observable to hosts (#86).
    return { step, ok: true, skipped: true };
  }
  const sinceRequestIndex = expect?.requestStatus
    ? (await driver.observe()).logic.requests.length
    : 0;
  const result = await executeStep(handlers, step, driver);
  if (!result.ok || !expect) return result;

  // Wait for the post-condition (readiness), don't check once — an async effect may land after the step.
  if (await pollCondition(driver, expect, expectTimeoutMs, { sinceRequestIndex, urlMatch })) return result;

  // Diverged: ran but `expect` didn't hold within the window — repair only this step.
  if (healer) {
    const healed = await healer.heal(step, index, driver);
    if (healed) {
      if (await pollCondition(driver, healed.step.expect ?? expect, expectTimeoutMs, { sinceRequestIndex, urlMatch })) {
        trace?.emit({
          kind: "heal",
          phase: "heal",
          stepRef: index,
          payload: { layer: "step", broke: step, became: healed.step, judgedBy: "original" },
        });
        return { step: healed.step, ok: true };
      }
    }
  }
  return { step, ok: false, error: `post-condition not met: ${JSON.stringify(expect)}`, errorKind: "post-condition" };
}

/**
 * Why a replay stopped collecting evidence partway, or `undefined` if every step ran. Assertions
 * only prove evidence that was *collected*: trailing steps never executed, so assertions satisfied
 * by the executed prefix must not read as a green (#90; same fail-closed stance as the
 * empty-assertion rule, #69). The string names the step and why, so a CI gate can tell "run didn't
 * finish" apart from "assertions failed"; a healed step is recorded ok, so a healed run is not
 * penalized. Pass the result as `finalizeVerdict`'s `incomplete`. A re-discovery is a loop rather
 * than a step list, so its "incomplete" is `Scenario.truncated` rendered as a reason — both feed
 * the same finalizer so a rule added there applies to both paths.
 */
export function blockedReason(actions: ExecutedAction[], totalSteps: number): string | undefined {
  const blockedAt = actions.findIndex((a) => !a.ok);
  if (blockedAt === -1) return undefined;
  const remaining = totalSteps - actions.length;
  return (
    `step ${blockedAt + 1}/${totalSteps} blocked: ${actions[blockedAt]?.error ?? "step failed"}` +
    (remaining > 0 ? ` (${remaining} later step(s) never ran)` : "")
  );
}

/** Fail a verdict for a reason the assertions could not see, keeping any detail the critic left. */
function failClosed(verdict: Verdict, why: string, kind: "blocked" | "truncated"): Verdict {
  return { ...verdict, passed: false, detail: verdict.detail ? `${verdict.detail}; ${why}` : why, failClosed: kind };
}

/** App-health guards: derived from the run's own traffic, not from what the flow set out to do. */
const GUARD_KINDS: ReadonlySet<string> = new Set(["no-failed-requests", "no-console-errors"]);

/**
 * The failures a re-discovery could conceivably repair: the goal assertions (`navigated`,
 * `request-status`, `custom`, `expect`), not the app-health guards. A 500 or a console error is
 * not a broken path — re-discovering cannot fix it, and a repair that reached the goal is still
 * the right path when a guard tripped on the way. Used on both ends of outcome-heal (#186): to
 * decide whether to re-discover at all, and as one half of whether to hand the repair back — the
 * other half is that the re-discovery reached `done` (`Scenario.truncated` unset), which this
 * function does not see: it filters `results` and never reads `passed` or `detail`.
 */
export function goalFailures(verdict: Verdict): AssertionResult[] {
  return verdict.results.filter((r) => !r.passed && !GUARD_KINDS.has(r.assertion.kind));
}

/**
 * The last word on a verdict, shared by replay and outcome-heal (#186). The critic judges the
 * assertions; `incomplete` is what the assertions cannot see about the run itself — a replay that
 * blocked (`blockedReason`, #90) or a re-discovery that ended before `done` — and either one means
 * the evidence stopped partway, so assertions satisfied by the prefix must not read as green. A
 * rule of that shape belongs here, not at a call site: the heal path once returned the critic's
 * verdict raw and silently skipped every rule the replay path applied.
 */
export function finalizeVerdict(
  judged: Verdict,
  incomplete?: string | { reason: string; kind: "blocked" | "truncated" },
  actions: readonly ExecutedAction[] = [],
): Verdict {
  // A bare string is what `blockedReason` returns, so it means a blocked replay; a re-discovery
  // that ended before `done` says so with the object form.
  const cut = typeof incomplete === "string" ? { reason: incomplete, kind: "blocked" as const } : incomplete;
  const verdict = cut ? failClosed(judged, cut.reason, cut.kind) : judged;
  if (verdict.passed) return verdict;
  return { ...verdict, failure: classifyFailure(verdict, actions) };
}

/** Statuses that say the app refused the caller (credentials, rate) rather than the flow. */
const REFUSED: ReadonlySet<number> = new Set([401, 403, 429]);

/** Every status the critic saw was a refusal — a still-pending `0` or any other status means the
 * endpoint did something else too, and that is the flow's. */
const refusedOnly = (r: AssertionResult) => r.statuses !== undefined && r.statuses.length > 0 && r.statuses.every((s) => REFUSED.has(s));

/**
 * Name the red (#173): which of three next actions a failed verdict calls for, read from the
 * structured signals the verdict carries (#212) — never from `detail`, which is for people. First
 * match wins, and the order is the priority a CI gate wants: a step that could not run outranks
 * what the assertions say about a run that stopped early.
 *
 * - a blocked step → by its `errorKind`: `transport` or `handler` → `environment` (the run's
 *   machinery, or the host's wiring); `resolution`, `post-condition`, `timeout`, or an untyped
 *   throw → `script`. Read from `actions`, or from `failClosed: "blocked"` when a caller finalized
 *   without them (then `script`: nothing says otherwise);
 * - failing closed because the freeze proves nothing or the re-discovery ended before `done` →
 *   `script`;
 * - a goal assertion failed → `flow`, unless every failed goal is a `request-status` whose every
 *   observed status was a refusal → `environment`;
 * - only the app-health guards failed → still `flow` (a 500 is the same 500 whether a goal or a
 *   guard saw it), unless every failed request the guard saw was a refusal → `environment`;
 * - every failure is the judge's own (`reason` set: LLM failed, no handler) → `environment`. Last,
 *   not first: the app's own failures, goals and guards, are read before a judge that could not
 *   judge names the class, so LLM flakiness next to a real 500 still reads as the 500;
 * - otherwise `flow`: when unsure, a red is a regression until shown otherwise.
 */
export function classifyFailure(verdict: Verdict, actions: readonly ExecutedAction[] = []): FailureClass {
  const blocked = actions.find((a) => !a.ok);
  if (blocked) return blocked.errorKind === "transport" || blocked.errorKind === "handler" ? "environment" : "script";
  if (verdict.failClosed !== undefined) return "script";
  const failed = verdict.results.filter((r) => !r.passed);
  const app = failed.filter((r) => r.reason === undefined); // what the app itself did, judge failures set aside
  const goals = app.filter((r) => !GUARD_KINDS.has(r.assertion.kind));
  if (goals.length > 0) return goals.every((r) => r.assertion.kind === "request-status" && refusedOnly(r)) ? "environment" : "flow";
  if (app.length > 0) return app.every((r) => r.assertion.kind === "no-failed-requests" && refusedOnly(r)) ? "environment" : "flow";
  if (failed.length > 0) return "environment";
  return "flow";
}

export async function runHarness(
  harness: Harness,
  task: string,
  opts: RunHarnessOptions = {},
): Promise<Result> {
  const { context, planner, driver, critic, reporter } = harness;
  const expectTimeoutMs = opts.expectTimeoutMs ?? DEFAULT_EXPECT_TIMEOUT_MS;
  const ctx = await context.provide(task);
  const scenario = await planner.plan(ctx);
  // `wildcards` rides with the scenario, not the run options: whether `*` means "one run-minted
  // segment" is a property of the file being replayed, and an older file predates the notation.
  const urlMatch: UrlMatchOptions = {
    localePrefixes: opts.localePrefixes,
    wildcards: scenario.wildcards,
  };
  const handlers = opts.stepHandlers ?? defaultStepHandlers(opts.actions ?? {}, urlMatch);

  // Drive steps; stop on the first failure but still observe the resulting state.
  // The driver is NOT closed here — whoever constructed it owns its lifecycle (#98).
  const actions: ExecutedAction[] = [];
  for (const step of scenario.steps) {
    opts.signal?.throwIfAborted(); // cooperative cancellation between steps (host owns Stop)
    const result = await runStep(handlers, step, driver, actions.length, expectTimeoutMs, urlMatch, opts.stepHealer, opts.trace);
    actions.push(result);
    // One capture serves both consumers — and only when someone stores it: a host timeline
    // (`onStep`) or a sink that keeps attachment bytes. Nobody watching = no screenshot taken.
    const wantsShot = opts.captureScreenshots && (opts.onStep !== undefined || opts.trace?.acceptsAttachments === true);
    const screenshot = wantsShot ? await driver.screenshot().catch(() => undefined) : undefined;
    // `result.step`, not `step` — a healed step is recorded as what actually ran. The `attachment`
    // ref is stamped by the Tracer from this event's `seq`; the bytes go to the sink, not the payload.
    opts.trace?.emit(
      {
        kind: "step",
        phase: "replay",
        stepRef: actions.length - 1,
        payload: { step: result.step, ok: result.ok, skipped: result.skipped, error: result.error, ...(result.errorKind ? { errorKind: result.errorKind } : {}) },
      },
      screenshot,
    );
    if (opts.onStep) {
      opts.onStep({ index: actions.length - 1, step, ok: result.ok, error: result.error, errorKind: result.errorKind, skipped: result.skipped, screenshot });
    }
    if (!result.ok) break;
  }

  // Auto-wait for network idle so evidence captures late subresources, not a race (design §3).
  await driver.settle();

  const observed = await driver.observe();
  const evidence: Evidence = {
    ...observed,
    execution: { ...observed.execution, actions, blocked: actions.some((a) => !a.ok) },
  };

  // Judge assertions, then require step completion too — either alone can miss a failure.
  const judged = await critic.judge(evidence, scenario.assertions, ctx);
  for (const r of judged.results) opts.trace?.emit({ kind: "assertion", phase: "replay", payload: assertionPayload(r) });
  const verdict = finalizeVerdict(judged, blockedReason(actions, scenario.steps.length), actions);
  const out: Result = { scenario: scenario.name, context: ctx, evidence, verdict };
  if (opts.usage) out.usage = opts.usage();
  await reporter.emit(out);
  return out;
}
