import { describe, expect, it } from "vitest";
import { runHarness } from "../../src/core/pipeline.js";
import { InlineContextProvider } from "../../src/adapters/context/inline.js";
import { StaticPlanner } from "../../src/adapters/planners/static.js";
import { AssertionCritic } from "../../src/adapters/critics/assertion.js";
import { FakeDriver } from "../../src/adapters/drivers/fake.js";
import type { ContextProvider } from "../../src/core/ports.js";
import type { Context, Evidence, Reporter, Result, Scenario, StepProgress } from "../../src/index.js";

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

describe("pipeline — browser actions", () => {
  it("executes hover / pressKey / scroll / select steps via the driver", async () => {
    const driver = new FakeDriver({ evidence: evidence(), elements: [] });
    const actions: Scenario = {
      name: "actions",
      steps: [
        { kind: "hover", target: { text: "Menu" } },
        { kind: "pressKey", key: "Enter" },
        { kind: "scroll", direction: "down" },
        { kind: "select", target: { text: "Country" }, value: "KR" },
      ],
      assertions: [],
    };
    await runHarness(
      {
        context: new InlineContextProvider(),
        planner: new StaticPlanner(actions),
        driver,
        critic: new AssertionCritic(),
        reporter: new CaptureReporter(),
      },
      actions.name,
    );
    expect(driver.hovered).toEqual([{ text: "Menu" }]);
    expect(driver.keys).toEqual(["Enter"]);
    expect(driver.scrolls).toEqual(["down"]);
  });

  it("runs a product-defined custom action via the registry", async () => {
    const driver = new FakeDriver({ evidence: evidence(), elements: [] });
    const seen: unknown[] = [];
    const sc: Scenario = { name: "custom", steps: [{ kind: "custom", name: "wiggle", params: { n: 3 } }], assertions: [] };
    await runHarness(
      {
        context: new InlineContextProvider(),
        planner: new StaticPlanner(sc),
        driver,
        critic: new AssertionCritic(),
        reporter: new CaptureReporter(),
      },
      sc.name,
      { actions: { wiggle: async (_d, params) => void seen.push(params.n) } },
    );
    expect(seen).toEqual([3]);
  });
});

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

  it("lets ContextProvider influence the result — intent overrides the scenario name", async () => {
    const driver = new FakeDriver({ evidence: evidence() });

    class CustomProvider implements ContextProvider {
      async provide(): Promise<Context> {
        return { intent: "grounding from a ticket" };
      }
    }

    const result = await runHarness(
      {
        context: new CustomProvider(),
        planner: new StaticPlanner(scenario),
        driver,
        critic: new AssertionCritic(),
        reporter: new CaptureReporter(),
      },
      "ignored task",
    );
    expect(result.scenario).toBe("grounding from a ticket");
    expect(result.verdict.passed).toBe(true);
  });

  it("surfaces a pre-check skip on the action and the step progress — never silent (#86)", async () => {
    // The step's expect already holds before it runs → the idempotency pre-check skips it. That
    // skip must be observable (ExecutedAction.skipped + StepProgress.skipped), so a wrongly
    // pre-satisfied expect (the #56→#86/#87/#96 failure class) can't hide as a plain ok.
    const driver = new FakeDriver({ evidence: evidence() }); // finalUrl already www.iana.org/help
    const progress: StepProgress[] = [];
    const sc: Scenario = {
      name: "skip",
      steps: [
        { kind: "click", target: { text: "Help" }, expect: { url: "www.iana.org/help" } },
        { kind: "pressKey", key: "Enter" },
      ],
      assertions: [],
    };
    const result = await runHarness(
      {
        context: new InlineContextProvider(),
        planner: new StaticPlanner(sc),
        driver,
        critic: new AssertionCritic(),
        reporter: new CaptureReporter(),
      },
      sc.name,
      { onStep: (p) => progress.push(p) },
    );
    expect(driver.clicked).toEqual([]); // step 0 skipped: goal already met
    expect(result.evidence.execution.actions[0]).toMatchObject({ ok: true, skipped: true });
    expect(progress[0]?.skipped).toBe(true);
    expect(result.evidence.execution.actions[1]?.skipped).toBeUndefined(); // executed step: no marker
    expect(progress[1]?.skipped).toBeUndefined();
  });

  it("threads localePrefixes into expect matching (consumer-declared locales, #86)", async () => {
    // "xx" is not in the engine's default locale list. Without injection the expect does not hold
    // (step executes); with the consumer's declaration the pre-check sees it as already reached.
    const at = (url: string) =>
      evidence({ execution: { actions: [], navigated: true, finalUrl: url, blocked: false } });
    const sc: Scenario = {
      name: "locale",
      steps: [{ kind: "click", target: { text: "Cart" }, expect: { url: "app.co/en/cart" } }],
      assertions: [],
    };
    const harness = (driver: FakeDriver) => ({
      context: new InlineContextProvider(),
      planner: new StaticPlanner(sc),
      driver,
      critic: new AssertionCritic(),
      reporter: new CaptureReporter(),
    });

    const withOption = new FakeDriver({ evidence: at("https://app.co/xx/cart") });
    const r1 = await runHarness(harness(withOption), sc.name, { localePrefixes: ["en", "xx"] });
    expect(withOption.clicked).toEqual([]); // already reached under the injected locale set
    expect(r1.evidence.execution.actions[0]).toMatchObject({ ok: true, skipped: true });

    const withoutOption = new FakeDriver({ evidence: at("https://app.co/xx/cart") });
    await runHarness(harness(withoutOption), sc.name, { expectTimeoutMs: 30 });
    expect(withoutOption.clicked).toEqual([{ text: "Cart" }]); // default list: xx is a real route
  });

  it("keeps the scenario's own name when intent is empty (default replay path)", async () => {
    const driver = new FakeDriver({ evidence: evidence() });

    class EmptyProvider implements ContextProvider {
      async provide(): Promise<Context> {
        return { intent: "" };
      }
    }

    const result = await runHarness(
      {
        context: new EmptyProvider(),
        planner: new StaticPlanner(scenario),
        driver,
        critic: new AssertionCritic(),
        reporter: new CaptureReporter(),
      },
      "ignored task",
    );
    expect(result.scenario).toBe("example → learn more"); // falls back to scenario.name
  });
});
