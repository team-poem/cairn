import { describe, expect, it } from "vitest";
import { applyHeals, needsLlmCritic, runScenario } from "./run.js";
import { FakeDriver } from "./adapters/drivers/fake.js";
import type { Evidence, Reporter, Result, Scenario } from "./index.js";

function evidence(): Evidence {
  return {
    execution: { actions: [], navigated: true, finalUrl: "https://iana.org", blocked: false },
    perception: {},
    logic: { requests: [{ method: "GET", url: "https://iana.org", status: 200 }], console: [] },
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

class CaptureReporter implements Reporter {
  last?: Result;
  async emit(r: Result): Promise<void> {
    this.last = r;
  }
}

describe("needsLlmCritic", () => {
  it("is false for mechanical-only scenarios, true with an expect", () => {
    expect(needsLlmCritic(scenario)).toBe(false);
    expect(needsLlmCritic({ ...scenario, assertions: [{ kind: "expect", criterion: "x" }] })).toBe(true);
  });
});

describe("applyHeals", () => {
  it("rewrites click/type targets and leaves the rest", () => {
    const healed = applyHeals(scenario, [{ original: { text: "Learn more" }, healedText: "Read more" }]);
    expect(healed.steps).toEqual([
      { kind: "goto", url: "https://example.com" },
      { kind: "click", target: { text: "Read more" } },
    ]);
  });
  it("returns the same scenario when there are no heals", () => {
    expect(applyHeals(scenario, [])).toBe(scenario);
  });
});

describe("runScenario", () => {
  it("runs with an injected driver and deterministic critic (no LLM, no heals)", async () => {
    const driver = new FakeDriver({ evidence: evidence() });
    const reporter = new CaptureReporter();
    const { result, heals, healedScenario } = await runScenario(scenario, { driver, reporter });

    expect(result.verdict.passed).toBe(true);
    expect(heals).toEqual([]);
    expect(healedScenario).toBeUndefined();
    expect(driver.settled).toBe(true);
    expect(reporter.last).toBe(result);
  });

  it("self-heals a broken target and returns a re-frozen scenario", async () => {
    // Frozen step says "Read more"; only "Learn more" exists → heal maps it.
    const driver = new FakeDriver({
      evidence: evidence(),
      elements: [{ role: "link", name: "Learn more" }],
      failOn: ["Read more"],
    });
    const broken: Scenario = {
      ...scenario,
      steps: [
        { kind: "goto", url: "https://example.com" },
        { kind: "click", target: { text: "Read more" } },
      ],
    };
    const llm = { id: "scripted", async complete() { return '{"name":"Learn more"}'; } };

    const { heals, healedScenario } = await runScenario(broken, { driver, llm, heal: true });

    expect(heals).toEqual([{ original: { text: "Read more" }, healedText: "Learn more" }]);
    expect(healedScenario?.steps[1]).toEqual({ kind: "click", target: { text: "Learn more" } });
  });
});
