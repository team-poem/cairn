import { expect, it } from "vitest";
import { runSuite, hashCase } from "../src/suite.js";
import { runScenario } from "../src/run.js";
import { createScrollNoProgressPolicy } from "../src/core/scroll-policy.js";
import type { Scenario, SkillStore, TraceEvent } from "../src/index.js";
import { ScriptedLlm, StubDriver } from "./support/doubles.js";

class Driver extends StubDriver {
  async scrollState() { return { region: "doc", x: 0, y: 0, width: 800, height: 600, scrollWidth: 800, scrollHeight: 600 }; }
}
const reporter = { emit: async () => {} };
const broken: Scenario = { name: "Goal", steps: [{ kind: "goto", url: "https://app/start" }],
  assertions: [{ kind: "navigated", to: "https://app/done" }] };
const llm = () => new ScriptedLlm(['{"action":"scroll"}', '{"action":"done"}', '[]']);
const policy = () => createScrollNoProgressPolicy({ tolerance: 1 });

it("suite preserves no-progress in the API and terminal trace, without freezing", async () => {
  const events: TraceEvent[] = [];
  const store: SkillStore = { load: async () => { throw new Error("missing"); }, freeze: async () => { throw new Error("must not freeze"); } };
  const result = await runSuite([{ id: "goal", intent: "Goal", url: "https://app/start", maxSteps: 20 }], {
    store, driverFactory: () => new Driver(), llm: llm(), policy: policy(), reporter, trace: { emit: e => events.push(e) },
  });
  expect(result.verdicts[0]).toMatchObject({ truncated: true, truncationReason: "no-progress", verdict: { passed: false } });
  expect(result.verdicts[0]!.verdict.detail).toContain("no-progress");
  expect(result.verdicts[0]!.verdict.detail).not.toContain("step cap");
  expect(events.find(e => e.kind === "case-end")?.payload).toMatchObject({ truncationReason: "no-progress" });
});

it.each([false, true])("outcome-heal preserves no-progress with budget=%s, and withholds the incomplete repair", async budgeted => {
  const events: TraceEvent[] = [];
  const result = await runScenario(broken, { driver: new Driver(), llm: llm(), heal: true, policy: policy(), reporter,
    ...(budgeted ? { budget: { maxModelCalls: 10 } } : {}), trace: { emit: e => events.push(e) } });
  expect(result).toMatchObject({ truncated: true, truncationReason: "no-progress", result: { verdict: { passed: false } } });
  expect(result.healedScenario).toBeUndefined();
  expect(result.result.verdict.detail).toContain("no-progress");
  expect(events.find(e => e.kind === "case-end")?.payload).toMatchObject({ truncationReason: "no-progress" });
});

it("a cached suite keeps outcome-heal's reason and never stores an incomplete replacement", async () => {
  const item = { id: "goal", intent: "Goal", url: "https://app/start" };
  const cached = { ...broken, caseHash: hashCase(item) };
  const store: SkillStore = { load: async () => cached, freeze: async () => { throw new Error("must not freeze"); } };
  const events: TraceEvent[] = [];
  const result = await runSuite([item], { store, driverFactory: () => new Driver(), llm: llm(),
    policy: policy(), reporter, trace: { emit: e => events.push(e) } });
  expect(result.verdicts[0]).toMatchObject({ discovered: false, truncated: true, truncationReason: "no-progress" });
  expect(events.find(e => e.kind === "case-end")?.payload).toMatchObject({ truncationReason: "no-progress" });
});
