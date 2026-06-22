/**
 * The execution body: Context → Plan → Execute → Judge → Report. Every variable behavior
 * is injected (invariant #2); with a fixed-scenario Planner + deterministic Critic, no LLM
 * runs (invariant #4).
 */
import type { Harness } from "./ports.js";
import type { Evidence, ExecutedAction, Result, Step } from "./types.js";

async function executeStep(driver: Harness["driver"], step: Step): Promise<ExecutedAction> {
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

export async function runHarness(harness: Harness, task: string): Promise<Result> {
  const { context, planner, driver, critic, reporter } = harness;

  const ctx = await context.provide(task);
  const scenario = await planner.plan(ctx);

  // Drive steps; stop on the first failure but still observe the resulting state.
  const actions: ExecutedAction[] = [];
  try {
    for (const step of scenario.steps) {
      const result = await executeStep(driver, step);
      actions.push(result);
      if (!result.ok) break;
    }

    // Auto-wait for network idle so evidence captures late subresources, not a race (design §3).
    await driver.settle();

    const observed = await driver.observe();
    const evidence: Evidence = {
      ...observed,
      execution: { ...observed.execution, actions, blocked: actions.some((a) => !a.ok) },
    };

    const verdict = await critic.judge(evidence, scenario.assertions);
    const out: Result = { scenario: scenario.name, context: ctx, evidence, verdict };
    await reporter.emit(out);
    return out;
  } finally {
    await driver.close();
  }
}
