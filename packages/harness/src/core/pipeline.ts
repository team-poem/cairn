/**
 * The execution body: Context → Plan → Execute → Judge → Report. Every variable behavior
 * is injected (invariant #2); with a fixed-scenario Planner + deterministic Critic, no LLM
 * runs (invariant #4).
 */
import type { CustomAction, Driver, Harness, StepHandler, StepHealer } from "./ports.js";
import type { Evidence, ExecutedAction, Result, Step, StepProgress, Verdict } from "./types.js";
import { conditionMet, defaultStepHandlers, pollCondition } from "./steps.js";
import type { UrlMatchOptions } from "./steps.js";

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
  /** First-path-segment prefixes URL matching may strip as locales (fallback only, #86). Which
   * segments are locales is an app trait the consumer declares — the engine default is a small
   * conservative list (`DEFAULT_LOCALE_PREFIXES`); override it when the app serves other locales
   * or has real routes that look like locales (`/my`, `/tv`). `[]` disables stripping. */
  localePrefixes?: readonly string[];
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
): Promise<ExecutedAction> {
  // A `requestStatus` expect is event evidence over the run's CUMULATIVE request log, not page
  // state: an idempotency pre-check would be satisfied by an earlier step's (or page-load's)
  // matching request and silently skip this step. Pre-check only state-like conditions, and gate
  // request matching to requests observed after this step started (watermark).
  if (step.expect && step.expect.requestStatus === undefined && (await conditionMet(driver, step.expect, 0, urlMatch))) {
    // Already satisfied — safe skip, but never a SILENT one: the marker keeps a wrongly
    // pre-satisfied expect (the #56→#86/#87/#96 failure class) observable to hosts (#86).
    return { step, ok: true, skipped: true };
  }
  const sinceRequestIndex = step.expect?.requestStatus
    ? (await driver.observe()).logic.requests.length
    : 0;
  const result = await executeStep(handlers, step, driver);
  if (!result.ok || !step.expect) return result;

  // Wait for the post-condition (readiness), don't check once — an async effect may land after the step.
  if (await pollCondition(driver, step.expect, expectTimeoutMs, { sinceRequestIndex, urlMatch })) return result;

  // Diverged: ran but `expect` didn't hold within the window — repair only this step.
  if (healer) {
    const healed = await healer.heal(step, index, driver);
    if (healed) {
      if (await pollCondition(driver, healed.step.expect ?? step.expect, expectTimeoutMs, { sinceRequestIndex, urlMatch })) {
        return { step: healed.step, ok: true };
      }
    }
  }
  return { step, ok: false, error: `post-condition not met: ${JSON.stringify(step.expect)}` };
}

/**
 * Fold step completion into the verdict: assertions only prove evidence that was *collected*, and a
 * blocked run stopped collecting partway — trailing steps never executed, so assertions satisfied by
 * the executed prefix must not read as a green (#90; same fail-closed stance as the empty-assertion
 * rule, #69). `detail` says which step blocked and why, so a CI gate can tell "run didn't finish"
 * apart from "assertions failed". A healed step is recorded ok, so a healed run is not penalized.
 */
function withStepCompletion(verdict: Verdict, actions: ExecutedAction[], totalSteps: number): Verdict {
  const blockedAt = actions.findIndex((a) => !a.ok);
  if (blockedAt === -1) return verdict;
  const remaining = totalSteps - actions.length;
  const why =
    `step ${blockedAt + 1}/${totalSteps} blocked: ${actions[blockedAt]?.error ?? "step failed"}` +
    (remaining > 0 ? ` (${remaining} later step(s) never ran)` : "");
  return { ...verdict, passed: false, detail: verdict.detail ? `${verdict.detail}; ${why}` : why };
}

export async function runHarness(
  harness: Harness,
  task: string,
  opts: RunHarnessOptions = {},
): Promise<Result> {
  const { context, planner, driver, critic, reporter } = harness;
  const handlers = opts.stepHandlers ?? defaultStepHandlers(opts.actions ?? {});
  const expectTimeoutMs = opts.expectTimeoutMs ?? DEFAULT_EXPECT_TIMEOUT_MS;
  const urlMatch: UrlMatchOptions = { localePrefixes: opts.localePrefixes };

  const ctx = await context.provide(task);
  const scenario = await planner.plan(ctx);

  // Drive steps; stop on the first failure but still observe the resulting state.
  const actions: ExecutedAction[] = [];
  try {
    for (const step of scenario.steps) {
      opts.signal?.throwIfAborted(); // cooperative cancellation between steps (host owns Stop)
      const result = await runStep(handlers, step, driver, actions.length, expectTimeoutMs, urlMatch, opts.stepHealer);
      actions.push(result);
      if (opts.onStep) {
        const screenshot = opts.captureScreenshots ? await driver.screenshot().catch(() => undefined) : undefined;
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
    const verdict = withStepCompletion(judged, actions, scenario.steps.length);
    const out: Result = { scenario: scenario.name, context: ctx, evidence, verdict };
    await reporter.emit(out);
    return out;
  } finally {
    await driver.close();
  }
}
