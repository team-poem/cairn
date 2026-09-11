// file: packages/harness/test/core/step-heal-attempt-budget.test.ts
import { expect, test } from "vitest";
import { LlmStepHealer } from "../../src/core/step-heal.js";
import { runHarness } from "../../src/core/pipeline.js";
import { InlineContextProvider } from "../../src/adapters/context/inline.js";
import { StaticPlanner } from "../../src/adapters/planners/static.js";
import { AssertionCritic } from "../../src/adapters/critics/assertion.js";
import { StubDriver } from "../support/doubles.js";
import type { Step, Scenario } from "../../src/core/types.js";

const budgetStep: Step = { kind: "click", target: { text: "Old checkout" }, intent: "go to payment", expect: { url: "https://app/payment" } };
function budgetDriver() {
  const driver = new StubDriver();
  driver.els = [{ role: "button", name: "Checkout" }];
  return driver;
}

test("stepHealReplayReuseHonorsAttemptBudget: repeated divergent replays sharing a healer cannot exceed its request cap", async () => {
  let calls = 0;
  const healer = new LlmStepHealer({ id: "counting", async complete() { calls++; return '{"action":"done"}'; } }, 1);
  for (const name of ["first divergence", "second divergence"]) {
    const scenario: Scenario = { name, steps: [budgetStep], assertions: [{ kind: "navigated", to: "https://app/payment" }] };
    const driver = budgetDriver();
    const result = await runHarness({ context: new InlineContextProvider(), planner: new StaticPlanner(scenario), driver, critic: new AssertionCritic(), reporter: { async emit() {} } }, name, { stepHealer: healer, expectTimeoutMs: 0 });
    expect(result.verdict.passed).toBe(false);
    expect(driver.clicked).toEqual(["Old checkout"]);
  }
  expect(calls).toBe(1);
  expect(healer.heals).toEqual([]);
});

test("stepHealRejectedRepliesConsumeAttempts: thrown, malformed, done and unusable responses each consume a model request", async () => {
  for (const reply of [new Error("model offline"), "not JSON", '{"action":"done"}', '{"action":"click"}']) {
    let calls = 0;
    const healer = new LlmStepHealer({ id: "counting", async complete() { calls++; if (reply instanceof Error) throw reply; return reply; } }, 1);
    const driver = budgetDriver();
    await expect(healer.heal(budgetStep, 0, driver)).resolves.toBeNull();
    await expect(healer.heal(budgetStep, 1, driver)).resolves.toBeNull();
    expect(calls).toBe(1);
    expect(healer.heals).toEqual([]);
    expect(driver.clicked).toEqual([]);
  }
});

test("stepHealPolicyRejectionConsumesAttempt: a rejected corrective action cannot request another model call beyond its cap", async () => {
  let calls = 0;
  const driver = budgetDriver();
  const healer = new LlmStepHealer({ id: "counting", async complete() { calls++; return '{"action":"click","text":"Checkout"}'; } }, 1, {}, { policy: { vet() { return { ok: false, reason: "blocked by consumer" }; } } });
  await expect(healer.heal(budgetStep, 0, driver)).resolves.toBeNull();
  await expect(healer.heal(budgetStep, 1, driver)).resolves.toBeNull();
  expect(calls).toBe(1);
  expect(healer.heals).toEqual([]);
  expect(driver.clicked).toEqual([]);
});

test("stepHealFailedDispatchAndSuccessShareBudget: a failed corrective dispatch uses one slot and a later successful repair uses the last", async () => {
  let calls = 0;
  const healer = new LlmStepHealer({ id: "counting", async complete() { calls++; return '{"action":"click","text":"Checkout"}'; } }, 2);
  const failing = budgetDriver();
  failing.click = async () => { throw new Error("target detached"); };
  await expect(healer.heal(budgetStep, 0, failing)).resolves.toBeNull();
  expect(healer.heals).toEqual([]);
  const working = budgetDriver();
  const healed = await healer.heal(budgetStep, 1, working);
  expect(healed).toMatchObject({ index: 1, step: { kind: "click", target: { text: "Checkout" }, expect: budgetStep.expect } });
  await expect(healer.heal(budgetStep, 2, working)).resolves.toBeNull();
  expect(calls).toBe(2);
  expect(healer.heals).toEqual([healed]);
  expect(working.clicked).toEqual(["Checkout"]);
});
