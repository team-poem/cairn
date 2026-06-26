/**
 * The execution body: Context → Plan → Execute → Judge → Report. Every variable behavior
 * is injected (invariant #2); with a fixed-scenario Planner + deterministic Critic, no LLM
 * runs (invariant #4).
 */
import type { CustomAction, Driver, Harness, StepHandler, StepHealer } from "./ports.js";
import type { Evidence, ExecutedAction, Result, Step, StepProgress } from "./types.js";
import { conditionMet, defaultStepHandlers } from "./steps.js";

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
  healer?: StepHealer,
): Promise<ExecutedAction> {
  if (step.expect && (await conditionMet(driver, step.expect))) {
    return { step, ok: true }; // already satisfied — safe skip
  }
  const result = await executeStep(handlers, step, driver);
  if (!result.ok || !step.expect) return result;

  await driver.settle();
  if (await conditionMet(driver, step.expect)) return result;

  // Diverged: ran but `expect` didn't hold — repair only this step.
  if (healer) {
    const healed = await healer.heal(step, index, driver);
    if (healed) {
      await driver.settle();
      if (await conditionMet(driver, healed.step.expect ?? step.expect)) {
        return { step: healed.step, ok: true };
      }
    }
  }
  return { step, ok: false, error: `post-condition not met: ${JSON.stringify(step.expect)}` };
}

export async function runHarness(
  harness: Harness,
  task: string,
  opts: RunHarnessOptions = {},
): Promise<Result> {
  const { context, planner, driver, critic, reporter } = harness;
  const handlers = opts.stepHandlers ?? defaultStepHandlers(opts.actions ?? {});

  const ctx = await context.provide(task);
  const scenario = await planner.plan(ctx);

  // Drive steps; stop on the first failure but still observe the resulting state.
  const actions: ExecutedAction[] = [];
  try {
    for (const step of scenario.steps) {
      opts.signal?.throwIfAborted(); // cooperative cancellation between steps (host owns Stop)
      const result = await runStep(handlers, step, driver, actions.length, opts.stepHealer);
      actions.push(result);
      if (opts.onStep) {
        const screenshot = opts.captureScreenshots ? await driver.screenshot().catch(() => undefined) : undefined;
        opts.onStep({ index: actions.length - 1, step, ok: result.ok, error: result.error, screenshot });
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

    const verdict = await critic.judge(evidence, scenario.assertions, ctx);
    const out: Result = { scenario: scenario.name, context: ctx, evidence, verdict };
    await reporter.emit(out);
    return out;
  } finally {
    await driver.close();
  }
}
