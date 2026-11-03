import { describe, expect, it } from "vitest";
import * as node from "../src/index.js";
import * as browser from "../src/browser.js";
import type { AssertionResult, Result, Scenario, Verdict } from "../src/index.js";

const ordinary: Scenario = {
  name: "checkout",
  steps: [{ kind: "goto", url: "https://shop.co/" }, { kind: "click", target: { text: "Buy" } }],
  assertions: [],
};
const positional: Scenario = {
  ...ordinary,
  steps: [ordinary.steps[0]!, {
    kind: "click",
    target: { collection: { root: { role: "list", name: "Results" }, itemRole: "listitem", target: { role: "link", name: "Open" }, order: "dom", index: 0 } },
  }],
};

const goal: AssertionResult = { assertion: { kind: "navigated", to: "shop.co/done" }, passed: false };
const guard: AssertionResult = { assertion: { kind: "no-console-errors" }, passed: false };
const inconclusive: AssertionResult = { assertion: { kind: "navigated", to: "shop.co/done" }, passed: false, reason: "inconclusive" };

function run(verdict: Partial<Verdict>, blocked = false): Pick<Result, "verdict" | "evidence"> {
  return {
    verdict: { passed: false, results: [], ...verdict },
    evidence: { execution: { actions: [], navigated: true, finalUrl: "https://shop.co/", blocked }, perception: {}, logic: { requests: [], console: [] } },
  };
}

describe.each([
  ["cairn-engine", node],
  ["cairn-engine/browser", browser],
])("%s rediscoveryEligibility (#326)", (_entry, api) => {
  const decide = api.rediscoveryEligibility;

  it("keeps blocked runs and failed goals eligible for ordinary scenarios", () => {
    expect(decide(ordinary, run({}, true))).toEqual({ eligible: true });
    expect(decide(ordinary, run({ results: [goal, guard] }))).toEqual({ eligible: true });
  });

  it("rejects a passed result", () => {
    expect(decide(ordinary, run({ passed: true }, true))).toEqual({ eligible: false, reason: "passed" });
  });

  it("rejects collection-position scenarios even when blocked or a goal failed", () => {
    expect(decide(positional, run({}, true))).toEqual({ eligible: false, reason: "collection-position" });
    expect(decide(positional, run({ results: [goal] }))).toEqual({ eligible: false, reason: "collection-position" });
  });

  it("rejects environment and budget failures", () => {
    expect(decide(ordinary, run({ results: [goal], failure: "environment" }, true))).toEqual({ eligible: false, reason: "environment" });
    expect(decide(ordinary, run({ results: [goal], failure: "budget" }, true))).toEqual({ eligible: false, reason: "budget" });
  });

  it("rejects guard-only and inconclusive-only failures without a blocked step", () => {
    expect(decide(ordinary, run({ results: [guard] }))).toEqual({ eligible: false, reason: "no-goal-failure" });
    expect(decide(ordinary, run({ results: [inconclusive, guard] }))).toEqual({ eligible: false, reason: "no-goal-failure" });
  });
});
