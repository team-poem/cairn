import { describe, expect, it } from "vitest";
import { applyHeals, needsLlmCritic, runScenario } from "./run.js";
import { FakeDriver } from "./adapters/drivers/fake.js";
import type { Evidence, Reporter, Result, Scenario, StepProgress } from "./index.js";

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
    const healed = applyHeals(scenario, [
      { original: { text: "Learn more" }, healed: { text: "Read more", role: "link", index: 0 } },
    ]);
    expect(healed.steps).toEqual([
      { kind: "goto", url: "https://example.com" },
      { kind: "click", target: { text: "Read more", role: "link", index: 0 } },
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

  it("streams per-step progress (with screenshots) to onStep — the desktop timeline seam", async () => {
    const driver = new FakeDriver({ evidence: evidence(), screenshot: "data:image/png;base64,AAA" });
    const events: StepProgress[] = [];
    await runScenario(scenario, { driver, onStep: (e) => events.push(e), screenshots: true });
    expect(events.map((e) => e.step.kind)).toEqual(["goto", "click"]);
    expect(events.every((e) => e.ok)).toBe(true);
    expect(events[0]?.screenshot).toBe("data:image/png;base64,AAA");
  });

  it("aborts between steps when the signal fires (a host's Stop button)", async () => {
    const driver = new FakeDriver({ evidence: evidence() });
    const ac = new AbortController();
    ac.abort();
    await expect(runScenario(scenario, { driver, signal: ac.signal })).rejects.toThrow();
    expect(driver.closed).toBe(true); // still cleaned up
  });

  it("outcome-heal judges the re-discovery against the ORIGINAL goal — no false green (P2)", async () => {
    const driver = new FakeDriver({ evidence: evidence(), elements: [] });
    // Original goal: reach the-moon; the flow only ever reaches iana.org. Re-discovery would ground
    // its OWN assertions in iana.org and pass — but judged against the original goal it must fail,
    // or a broken page that lands somewhere else passes as green.
    const broken: Scenario = {
      name: "reach the moon",
      steps: [{ kind: "goto", url: "https://example.com" }],
      assertions: [{ kind: "navigated", to: "the-moon" }],
    };
    let i = 0;
    const replies = ['{"action":"done"}', "[]"]; // re-discover: done immediately, no extra assertions
    const llm = { id: "scripted", async complete() { return replies[i++] ?? '{"action":"done"}'; } };

    const { result, healedScenario } = await runScenario(broken, { driver, llm, heal: true });

    expect(result.verdict.passed).toBe(false); // reached iana.org, not the-moon → not a green
    expect(healedScenario?.assertions).toEqual([{ kind: "navigated", to: "the-moon" }]); // original goal kept
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

    expect(heals).toEqual([
      { original: { text: "Read more" }, healed: { text: "Learn more", role: "link", index: 0 } },
    ]);
    expect(healedScenario?.steps[1]).toEqual({
      kind: "click",
      target: { text: "Learn more", role: "link", index: 0 },
    });
  });
});
