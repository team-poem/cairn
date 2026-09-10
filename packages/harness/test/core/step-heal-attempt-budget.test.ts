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
