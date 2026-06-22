import { describe, expect, it } from "vitest";
import { runHarness } from "./pipeline.js";
import { InlineContextProvider } from "./context/inline.js";
import { StaticPlanner } from "./planners/static.js";
import { AssertionCritic } from "./critics/assertion.js";
import { FakeDriver } from "./drivers/fake.js";
import type { Evidence, Reporter, Result, Scenario } from "./index.js";

class CaptureReporter implements Reporter {
  last?: Result;
  async emit(result: Result): Promise<void> {
    this.last = result;
  }
}

function evidence(over: Partial<Evidence> = {}): Evidence {
  return {
    execution: { actions: [], navigated: true, finalUrl: "https://www.iana.org/help", blocked: false },
    perception: {},
    logic: {
      requests: [{ method: "GET", url: "https://www.iana.org/help", status: 200 }],
      console: [],
    },
    ...over,
  };
}

const scenario: Scenario = {
  name: "example → learn more",
  steps: [
    { kind: "goto", url: "https://example.com" },
    { kind: "click", target: { text: "Learn more" } },
  ],
  assertions: [{ kind: "navigated" }, { kind: "no-failed-requests" }],
};

describe("pipeline", () => {
  it("runs Context→Plan→Execute→Judge→Report and passes on clean evidence", async () => {
    const driver = new FakeDriver({ evidence: evidence() });
    const reporter = new CaptureReporter();
    const result = await runHarness(
      {
        context: new InlineContextProvider(),
        planner: new StaticPlanner(scenario),
        driver,
        critic: new AssertionCritic(),
        reporter,
      },
      "qa: example learn more",
    );

    expect(result.verdict.passed).toBe(true);
    expect(driver.visited).toEqual(["https://example.com"]);
    expect(driver.clicked).toEqual([{ text: "Learn more" }]);
    expect(driver.closed).toBe(true); // driver always closed
    expect(driver.settled).toBe(true); // Execute auto-waits before observing
    expect(reporter.last).toBe(result);
    expect(result.evidence.execution.actions).toHaveLength(2);
  });

  it("fails the verdict when a request failed", async () => {
    const driver = new FakeDriver({
      evidence: evidence({
        logic: { requests: [{ method: "GET", url: "/api/orders", status: 500 }], console: [] },
      }),
    });
    const result = await runHarness(
      {
        context: new InlineContextProvider(),
        planner: new StaticPlanner(scenario),
        driver,
        critic: new AssertionCritic(),
        reporter: new CaptureReporter(),
      },
      "task",
    );
    expect(result.verdict.passed).toBe(false);
    expect(result.verdict.results.find((r) => r.assertion.kind === "no-failed-requests")?.passed).toBe(false);
  });

  it("stops driving after a failed step and marks execution blocked", async () => {
    const driver = new FakeDriver({ evidence: evidence(), failOn: ["Learn more"] });
    const result = await runHarness(
      {
        context: new InlineContextProvider(),
        planner: new StaticPlanner(scenario),
        driver,
        critic: new AssertionCritic(),
        reporter: new CaptureReporter(),
      },
      "task",
    );
    expect(result.evidence.execution.blocked).toBe(true);
    const actions = result.evidence.execution.actions;
    expect(actions[actions.length - 1]?.ok).toBe(false);
  });
});
