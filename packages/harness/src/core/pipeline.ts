/**
 * The pipeline IS the execution body: Context → Plan → Execute → Judge → Report.
 *
 * No branching on environment or domain lives here (invariant #2) — every variable
 * behavior arrives through an injected interface. The replay path this orchestrates is
 * deterministic (invariant #4): given a Planner that resolves a fixed scenario and a
 * deterministic Critic, no LLM is in the loop.
 */
import type { Harness } from "./ports.js";
import type { Evidence, ExecutedAction, Result, Step } from "./types.js";

/** Execute one step against the driver, capturing success/failure as evidence. */
async function executeStep(
  driver: Harness["driver"],
  step: Step,
): Promise<ExecutedAction> {
  try {
    switch (step.kind) {
      case "goto":
        await driver.goto(step.url);
        break;
      case "click":
        await driver.click(step.target);
        break;
      case "type":
        await driver.type(step.target, step.text);
        break;
    }
    return { step, ok: true };
  } catch (err) {
    return { step, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Run the full pipeline for a single task and return the emitted result. */
export async function runHarness(harness: Harness, task: string): Promise<Result> {
  const { context, planner, driver, critic, reporter } = harness;

  // Context
  const ctx = await context.provide(task);

  // Plan
  const scenario = await planner.plan(ctx);

  // Execute — run steps, stop driving on the first failure but still observe.
  const actions: ExecutedAction[] = [];
  try {
    for (const step of scenario.steps) {
      const result = await executeStep(driver, step);
      actions.push(result);
      if (!result.ok) break;
    }

    // Auto-wait: let the page go network-idle before observing (design §3), so evidence
    // captures late subresources instead of racing them. Best-effort; never fails a run.
    await driver.settle();

    const observed = await driver.observe();
    const evidence: Evidence = {
      ...observed,
      execution: {
        ...observed.execution,
        actions,
        blocked: actions.some((a) => !a.ok),
      },
    };

    // Judge
    const verdict = await critic.judge(evidence, scenario.assertions);

    // Report
    const out: Result = { scenario: scenario.name, context: ctx, evidence, verdict };
    await reporter.emit(out);
    return out;
  } finally {
    await driver.close();
  }
}
