/**
 * The execution body: Context → Plan → Execute → Judge → Report. Every variable behavior
 * is injected (invariant #2); with a fixed-scenario Planner + deterministic Critic, no LLM
 * runs (invariant #4).
 */
import type { Driver, Harness } from "./ports.js";
import type { Evidence, ExecutedAction, Result, Step, StepProgress } from "./types.js";

/** A product-defined interaction for a `{ kind: "custom", name }` step — composes the Driver. */
export type CustomAction = (driver: Driver, params: Record<string, unknown>) => Promise<void>;

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
  actions?: Record<string, CustomAction>;
}

async function executeStep(
  driver: Harness["driver"],
  step: Step,
  actions: Record<string, CustomAction>,
): Promise<ExecutedAction> {
  try {
    switch (step.kind) {
      case "goto":
        await driver.goto(step.url);
        break;
      case "click":
        await driver.click(step.target);
        break;
      case "doubleClick":
        await driver.doubleClick(step.target);
        break;
      case "hover":
        await driver.hover(step.target);
        break;
      case "type":
        await driver.type(step.target, step.text);
        break;
      case "select":
        await driver.select(step.target, step.value);
        break;
      case "pressKey":
        await driver.pressKey(step.key);
        break;
      case "scroll":
        await driver.scroll(step.direction);
        break;
      case "custom": {
        const handler = actions[step.name];
        if (!handler) throw new Error(`no handler registered for custom action "${step.name}"`);
        await handler(driver, step.params ?? {});
        break;
      }
      default: {
        const unhandled: never = step;
        throw new Error(`unhandled step kind: ${JSON.stringify(unhandled)}`);
      }
    }
    return { step, ok: true };
  } catch (err) {
    return { step, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runHarness(
  harness: Harness,
  task: string,
  opts: RunHarnessOptions = {},
): Promise<Result> {
  const { context, planner, driver, critic, reporter } = harness;

  const ctx = await context.provide(task);
  const scenario = await planner.plan(ctx);

  // Drive steps; stop on the first failure but still observe the resulting state.
  const actions: ExecutedAction[] = [];
  try {
    for (const step of scenario.steps) {
      opts.signal?.throwIfAborted(); // cooperative cancellation between steps (host owns Stop)
      const result = await executeStep(driver, step, opts.actions ?? {});
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
