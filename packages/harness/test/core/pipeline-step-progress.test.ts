import { describe, expect, it } from "vitest";
import { runHarness } from "../../src/core/pipeline.js";
import { InlineContextProvider } from "../../src/adapters/context/inline.js";
import { StaticPlanner } from "../../src/adapters/planners/static.js";
import { AssertionCritic } from "../../src/adapters/critics/assertion.js";
import type { Scenario, Step, StepHealer, StepProgress } from "../../src/index.js";
import type { TraceEvent } from "../../src/core/trace.js";
import { startTrace } from "../../src/core/trace.js";
import { ENGINE_VERSION } from "../../src/version.js";
import { StubDriver } from "../support/doubles.js";

// #313: onStep, the action entry and the step trace event describe the same executed step.
async function replay(driver: StubDriver, steps: Step[], stepHealer?: StepHealer) {
  const sc: Scenario = { name: "progress", steps, assertions: [{ kind: "navigated" }] };
  const progress: StepProgress[] = [];
  const events: TraceEvent[] = [];
  const tracer = startTrace({ emit: (e) => events.push(e) }, ENGINE_VERSION);
  const result = await runHarness(
    { context: new InlineContextProvider(), planner: new StaticPlanner(sc), driver, critic: new AssertionCritic(), reporter: { emit: async () => {} } },
    sc.name,
    { stepHealer, expectTimeoutMs: 20, onStep: (p) => progress.push(p), trace: tracer.scope(sc.name) },
  );
  const traced = events.flatMap((e) => (e.kind === "step" ? [{ stepRef: e.stepRef, ...e.payload }] : []));
  const actions = result.evidence.execution.actions;
  expect(progress.map((p) => p.index)).toEqual(actions.map((_, i) => i));
  expect(traced.map((t) => t.stepRef)).toEqual(actions.map((_, i) => i));
  actions.forEach((action, i) => {
    expect(progress[i]).toEqual({ ...action, index: i, screenshot: undefined });
    expect(traced[i]).toMatchObject({ step: action.step, ok: action.ok, skipped: action.skipped });
  });
  return { result, progress };
}

const original: Step = { kind: "click", target: { text: "Original" }, expect: { url: "app/done" } };
const repaired: Step = { kind: "click", target: { text: "Repaired" }, expect: { url: "app/done" } };
const healTo = (step: Step): StepHealer => ({
  async heal(_step, index, d) {
    await d.click(step.kind === "click" ? step.target : {});
    return { index, step };
  },
});

describe("replay step progress", () => {
  it("reports the repaired step after a successful replacement", async () => {
    const driver = new StubDriver();
    driver.navOn.Repaired = "https://app/done";
    const { result, progress } = await replay(driver, [original], healTo(repaired));
    expect(result.verdict.passed).toBe(true);
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ index: 0, step: repaired, ok: true });
  });

  it("reports each planned step for ordinary execution", async () => {
    const driver = new StubDriver();
    driver.navOn.Original = "https://app/done";
    const steps: Step[] = [original, { kind: "pressKey", key: "Enter" }];
    const { progress } = await replay(driver, steps);
    expect(progress.map((p) => p.step)).toEqual(steps);
    expect(progress.every((p) => p.ok && !p.skipped)).toBe(true);
  });

  it("reports the original step as failed when the replacement does not reach the expect", async () => {
    const { result, progress } = await replay(new StubDriver(), [original, { kind: "pressKey", key: "Enter" }], healTo(repaired));
    expect(result.verdict.passed).toBe(false);
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ index: 0, step: original, ok: false });
  });

  it("reports the original step as skipped when its expect already holds", async () => {
    const { progress } = await replay(new StubDriver("https://app/done"), [original], healTo(repaired));
    expect(progress[0]).toMatchObject({ index: 0, step: original, ok: true, skipped: true });
  });
});
