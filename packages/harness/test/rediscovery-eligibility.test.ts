import { describe, expect, it, vi } from "vitest";
import { FakeDriver } from "../src/adapters/drivers/fake.js";
import { runScenario } from "../src/run.js";
import * as node from "../src/index.js";
import * as browser from "../src/browser.js";
import type { Assertion, AssertionResult, Evidence, Result, Scenario, Verdict } from "../src/index.js";

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
    expect(decide(ordinary, run({ results: [inconclusive, guard] }))).toEqual({ eligible: false, reason: "inconclusive" });
  });

  it("reports the collection position before an environment failure", () => {
    expect(decide(positional, run({ results: [goal], failure: "environment" }, true))).toEqual({ eligible: false, reason: "collection-position" });
  });
});

describe("runScenario explains a skipped outcome-heal by its eligibility reason", () => {
  const arrival: Assertion = { kind: "navigated", to: "https://app/done" };
  const evidence = (status: number): Evidence => ({
    execution: { actions: [], navigated: true, finalUrl: "https://app/done", blocked: false },
    perception: {}, logic: { requests: [{ method: "GET", url: "https://app/api", status }], console: [] },
  });
  const heal = async (assertions: Assertion[], status = 200) => {
    const complete = vi.fn(async () => JSON.stringify({ action: "done" }));
    const { result } = await runScenario({ name: "skip", steps: [], assertions }, {
      driver: new FakeDriver({ evidence: evidence(status) }), heal: true,
      custom: { session: () => ({ inconclusive: true, detail: "No session evidence" }) },
      llm: { id: "scripted", complete }, reporter: { emit: async () => {} },
    });
    expect(complete).not.toHaveBeenCalled();
    return result.verdict.detail;
  };

  it("names unjudged checks when nothing failed but some could not be judged", async () => {
    expect(await heal([{ kind: "custom", name: "session" }]))
      .toMatch(/(^|; )outcome-heal skipped: no failed goal to repair; some checks could not be judged$/);
  });

  it("names the app-health guards when only they failed", async () => {
    expect(await heal([arrival, { kind: "no-failed-requests" }], 500))
      .toMatch(/(^|; )outcome-heal skipped: only app-health guards failed, and a re-discovery cannot fix those$/);
  });
});
