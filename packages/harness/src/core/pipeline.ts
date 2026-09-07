/**
 * The execution body: Context → Plan → Execute → Judge → Report. Every variable behavior
 * is injected (invariant #2); with a fixed-scenario Planner + deterministic Critic, no LLM
 * runs (invariant #4).
 */
import type { CustomAction, Driver, Harness, StepHandler, StepHealer } from "./ports.js";
import type { AssertionResult, Evidence, ExecutedAction, Result, RunUsage, Step, StepProgress, Verdict, FailureClass } from "./types.js";
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
    if (!handler) throw new Error(`no step handler for kind "${step.kind}"`);
    await handler.execute(step, driver);
    return { step, ok: true };
  } catch (err) {
    return { step, ok: false, error: err instanceof Error ? err.message : String(err) };
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
  return { step, ok: false, error: `post-condition not met: ${JSON.stringify(expect)}` };
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
function failClosed(verdict: Verdict, why: string): Verdict {
  return { ...verdict, passed: false, detail: verdict.detail ? `${verdict.detail}; ${why}` : why };
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
export function finalizeVerdict(judged: Verdict, incomplete?: string, actions: readonly ExecutedAction[] = []): Verdict {
  const verdict = incomplete ? failClosed(judged, incomplete) : judged;
  if (verdict.passed) return verdict;
  return { ...verdict, failure: classifyFailure(verdict, actions) };
}

/** A step error the driver phrased for a target it could not resolve. It embeds the target's
 * own text (`no element matching {"text":"Transport options"}`), so it is decided FIRST and never
 * scanned for environment markers: it is the script's, whatever words the page uses. */
const RESOLUTION_MISS = /^(?:no element matching|\d+ elements named|self-heal (?:found no match|budget))/;

/** Errors that say the run's machinery failed, not the app or the script. Anchored to the
 * driver's own phrasing (chrome.ts) or to unambiguous transport tokens, never to bare words: the
 * `MCP <tool> failed:` envelope carries page text and puppeteer's own messages ("did not become
 * interactive"), so the envelope proves nothing — only a transport token inside it does. */
const ENVIRONMENT_ERROR = /^(?:browser session ended|driver closed|failed to start chrome-devtools-mcp|MCP \S+ timed out after \d+ms)|chrome-devtools-mcp transport closed|Target closed|net::ERR_[A-Z_]+|\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND)\b/;

/** The host wired the run wrong: a step or check names a handler nothing registered. Not the app,
 * not the script — the same defect whether it surfaces as a step error or an assertion detail. */
const HOST_CONFIG_ERROR = /^(?:no handler registered for custom action|no step handler for kind)|needs a registered handler|no custom check registered|no critic handles/;

/** Statuses that say the app refused the caller (credentials, rate) rather than the flow. */
const REFUSED = new Set([401, 403, 429]);

/** Every status the `request-status` critic saw for the endpoint (`expected 200, got 401, 500 for …`
 * joins the distinct statuses in arrival order). Refused means ALL of them refused: reading only
 * the first would make the class depend on which response landed first, which the critic itself
 * was written not to do. */
function refusedOnly(detail: string): boolean {
  const seen = detail.match(/\bgot ((?:\d{3})(?:, \d{3})*)\b/)?.[1];
  return seen !== undefined && seen.split(", ").every((s) => REFUSED.has(Number(s)));
}

/** The failed-requests guard names only its FIRST failure (`4 failed request(s): 429 …`), so a
 * refusal there proves the environment only when it was the only failure. The guard's text is
 * URLs and app console output — never scanned for environment tokens. */
function guardRefused(r: AssertionResult): boolean {
  const m = (r.detail ?? "").match(/^1 failed request\(s\): (\d{3}) /);
  return r.assertion.kind === "no-failed-requests" && m !== null && REFUSED.has(Number(m[1]));
}

const judgeFailed = (r: AssertionResult) => /^LLM judgment failed/.test(r.detail ?? "") || HOST_CONFIG_ERROR.test(r.detail ?? "");

/**
 * Name the red (#173): which of three next actions a failed verdict calls for, from signals the
 * verdict path already holds. First match wins, and the order is the priority a CI gate wants —
 * a step that could not run outranks what the assertions say about a run that stopped early.
 *
 * - a blocked step → `script` (target missing, post-condition never held, waitFor timed out),
 *   unless its error is the driver's own transport failure or a handler the host never registered
 *   → `environment`. Read from `actions`, or from a `blocked:` detail when a caller finalized
 *   without them;
 * - failing closed because the freeze proves nothing (no assertions, every check vacuous) or the
 *   re-discovery ended before `done` → `script`;
 * - a goal assertion failed → `flow`, unless every failed goal is a request the app refused with
 *   401/403/429 (every status it saw, not the first) → `environment`. A judge that could not judge
 *   (LLM failed, no handler for a check) is set aside here: it is `environment` only when nothing
 *   else failed, so LLM flakiness next to a real regression still reads as the regression;
 * - only the app-health guards failed → still `flow` (a 500 is the same 500 whether a goal or a
 *   guard saw it), unless the single failed request was a refusal → `environment`;
 * - otherwise `flow`: when unsure, a red is a regression until shown otherwise.
 */
export function classifyFailure(verdict: Verdict, actions: readonly ExecutedAction[] = []): FailureClass {
  const detail = verdict.detail ?? "";
  const blockedError = actions.find((a) => !a.ok)?.error
    ?? detail.match(/step \d+\/\d+ blocked: (.*)$/)?.[1]?.replace(/ \(\d+ later step\(s\) never ran\)$/, "");
  if (blockedError !== undefined) {
    if (RESOLUTION_MISS.test(blockedError)) return "script";
    return ENVIRONMENT_ERROR.test(blockedError) || HOST_CONFIG_ERROR.test(blockedError) ? "environment" : "script";
  }
  if (/no assertions to verify|already satisfied before the flow ran|no destination could be frozen|ended before `done`|unverified path/.test(detail)) return "script";
  const failed = verdict.results.filter((r) => !r.passed);
  const goals = goalFailures(verdict).filter((r) => !judgeFailed(r));
  if (goals.length > 0) {
    return goals.every((r) => r.assertion.kind === "request-status" && refusedOnly(r.detail ?? "")) ? "environment" : "flow";
  }
  if (/^LLM judgment failed/.test(detail) || failed.some(judgeFailed)) return "environment";
  if (failed.length > 0 && failed.every(guardRefused)) return "environment";
  return "flow";
}

export async function runHarness(
  harness: Harness,
  task: string,
  opts: RunHarnessOptions = {},
): Promise<Result> {
  const { context, planner, driver, critic, reporter } = harness;
  const handlers = opts.stepHandlers ?? defaultStepHandlers(opts.actions ?? {});
  const expectTimeoutMs = opts.expectTimeoutMs ?? DEFAULT_EXPECT_TIMEOUT_MS;
  const ctx = await context.provide(task);
  const scenario = await planner.plan(ctx);
  // `wildcards` rides with the scenario, not the run options: whether `*` means "one run-minted
  // segment" is a property of the file being replayed, and an older file predates the notation.
  const urlMatch: UrlMatchOptions = {
    localePrefixes: opts.localePrefixes,
    wildcards: scenario.wildcards,
  };

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
        payload: { step: result.step, ok: result.ok, skipped: result.skipped, error: result.error },
      },
      screenshot,
    );
    if (opts.onStep) {
      opts.onStep({ index: actions.length - 1, step, ok: result.ok, error: result.error, skipped: result.skipped, screenshot });
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
