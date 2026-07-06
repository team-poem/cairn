import { describe, expect, it } from "vitest";
import { applyHeals, needsLlmCritic, runScenario } from "../src/run.js";
import { FakeDriver } from "../src/adapters/drivers/fake.js";
import { ScriptedLlm, StubDriver } from "./support/doubles.js";
import type { Evidence, Reporter, Result, Scenario, Step, StepProgress, Target } from "../src/index.js";

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
  it("rewrites only the healed step's target by identity, leaving a duplicate label alone (#39)", () => {
    const broken = { text: "Learn more" };
    const s: Scenario = {
      name: "t",
      steps: [
        { kind: "goto", url: "https://example.com" },
        { kind: "click", target: broken },
        { kind: "click", target: { text: "Learn more" } }, // same label, a different element
      ],
      assertions: [],
    };
    const healed = applyHeals(s, [
      { original: broken, healed: { text: "Read more", role: "link", index: 0 } },
    ]);
    expect(healed.steps[1]).toEqual({ kind: "click", target: { text: "Read more", role: "link", index: 0 } });
    expect(healed.steps[2]).toEqual({ kind: "click", target: { text: "Learn more" } }); // untouched
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

  it("a deterministic replay reports llmCalls: 0 — the cost proof rides in the result (#100)", async () => {
    const driver = new FakeDriver({ evidence: evidence() });
    const { result } = await runScenario(scenario, { driver });
    expect(result.usage).toEqual({ llmCalls: 0, measuredCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  });

  it("counts LLM calls made by heal paths, host-injected client included (#100)", async () => {
    const driver = new FakeDriver({ evidence: evidence(), elements: [] });
    const broken: Scenario = {
      name: "reach the moon",
      steps: [{ kind: "goto", url: "https://example.com" }],
      assertions: [{ kind: "navigated", to: "the-moon" }],
    };
    let i = 0;
    const replies = ['{"action":"done"}', "[]"];
    const llm = { id: "scripted", async complete() { return replies[i++] ?? '{"action":"done"}'; } };
    const { result } = await runScenario(broken, { driver, llm, heal: true });
    expect(result.usage?.llmCalls).toBeGreaterThan(0);
    expect(result.usage?.measuredCalls).toBe(0); // scripted backend reports no tokens — never fabricated
  });

  it("a custom ContextProvider's intent no longer relabels the frozen scenario (#13)", async () => {
    const driver = new FakeDriver({ evidence: evidence() });
    const context = { async provide() { return { intent: "free-text goal from a ticket" }; } };
    const { result } = await runScenario(scenario, { driver, context });
    expect(result.scenario).toBe(scenario.name); // stable identity
    expect(result.context.intent).toBe("free-text goal from a ticket"); // intent's one home
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

// --- per-step expect verification (surgical-heal, spec/core/surgical-heal.md) --------------------

const silent: Reporter = { emit: async () => {} };
// One real assertion — an empty set fails closed (#69), which would trigger outcome-heal here.
const scn = (steps: Step[]): Scenario => ({ name: "t", steps, assertions: [{ kind: "navigated" }] });

describe("per-step expect verification", () => {
  it("skips a step whose expect already holds (idempotency)", async () => {
    const driver = new StubDriver("https://app/home");
    const s = scn([{ kind: "click", target: { text: "Login" }, expect: { url: "app/home" } }]);
    const { result } = await runScenario(s, { driver, reporter: silent });
    expect(driver.clicked).toEqual([]); // never executed — goal already met
    expect(result.evidence.execution.actions[0]?.ok).toBe(true);
  });

  it("fails a step that ran but whose expect diverges (no healer)", async () => {
    const driver = new StubDriver(); // "Checkout" does not navigate
    const s = scn([{ kind: "click", target: { text: "Checkout" }, expect: { url: "app/payment" } }]);
    const { result } = await runScenario(s, { driver, reporter: silent, expectTimeoutMs: 50 });
    expect(driver.clicked).toEqual(["Checkout"]); // executed
    expect(result.evidence.execution.actions[0]?.ok).toBe(false);
    expect(result.evidence.execution.actions[0]?.error).toContain("post-condition");
  });

  it("surgically heals a diverged step from its intent, then re-freezes it", async () => {
    const driver = new StubDriver();
    driver.els = [{ role: "button", name: "Checkout Now" }];
    driver.navOn["Checkout Now"] = "https://app/payment"; // the right control navigates
    const llm = new ScriptedLlm(['{"action":"click","text":"Checkout Now"}']);
    const s = scn([
      { kind: "click", target: { text: "Checkout" }, intent: "go to payment", expect: { url: "app/payment" } },
    ]);
    const { result, stepHeals, healedScenario } = await runScenario(s, {
      driver,
      llm,
      heal: true,
      reporter: silent,
      expectTimeoutMs: 50,
    });
    expect(result.evidence.execution.actions[0]?.ok).toBe(true); // healed → step passes
    expect(driver.clicked).toEqual(["Checkout", "Checkout Now"]); // original, then corrective
    expect(stepHeals).toHaveLength(1);
    expect(healedScenario?.steps[0]).toMatchObject({
      kind: "click",
      target: { text: "Checkout Now" },
      expect: { url: "app/payment" },
    });
  });

  it("waits for an async post-condition before declaring divergence (readiness poll)", async () => {
    // The click's effect (navigation) lands on a LATER observe, not immediately — an async redirect.
    // A single post-step check would race it; polling the `expect` catches it, with no heal / no LLM.
    class AsyncNav extends StubDriver {
      private observes = 0;
      override async click(t: Target): Promise<void> {
        this.clicked.push(t.text ?? "");
      }
      override async observe(): Promise<Evidence> {
        this.observes += 1;
        const finalUrl = this.observes > 2 ? "https://app/payment" : this.url;
        return {
          execution: { actions: [], navigated: true, finalUrl, blocked: false },
          perception: {},
          logic: { requests: [], console: [] },
        };
      }
    }
    const driver = new AsyncNav();
    const s = scn([{ kind: "click", target: { text: "Checkout" }, expect: { url: "app/payment" } }]);
    const { result } = await runScenario(s, { driver, reporter: silent });
    expect(result.evidence.execution.actions[0]?.ok).toBe(true); // async effect caught by polling
    expect(driver.clicked).toEqual(["Checkout"]); // clicked once, not re-clicked or healed
  });

  it("a requestStatus expect is NOT satisfied by an earlier request (watermark, no pre-skip)", async () => {
    // The matching POST is already in the run's cumulative log (an earlier step / page load fired
    // it). This step's own click sends nothing — it must execute (no idempotency pre-skip) and then
    // diverge, not pass off the stale request.
    class StaleRequestStub extends StubDriver {
      override async observe(): Promise<Evidence> {
        return {
          execution: { actions: [], navigated: false, finalUrl: this.url, blocked: false },
          perception: {},
          logic: { requests: [{ method: "POST", url: "https://api.app/cart", status: 200 }], console: [] },
        };
      }
    }
    const driver = new StaleRequestStub();
    const s = scn([
      {
        kind: "click",
        target: { text: "Add" },
        expect: { requestStatus: { urlIncludes: "api.app/cart", status: 200, method: "POST" } },
      },
    ]);
    const { result } = await runScenario(s, { driver, reporter: silent, expectTimeoutMs: 50 });
    expect(driver.clicked).toEqual(["Add"]); // executed — not skipped as "already satisfied"
    expect(result.evidence.execution.actions[0]?.ok).toBe(false); // stale request doesn't count
  });

  it("a same-path GET does not satisfy a mutation-derived expect (method match)", async () => {
    // After the click, only a GET to the same endpoint+status arrives (a list re-fetch) — the
    // frozen POST expect must not accept it.
    class GetOnlyStub extends StubDriver {
      readonly requests: { method: string; url: string; status: number }[] = [];
      override async click(t: Target): Promise<void> {
        this.clicked.push(t.text ?? "");
        this.requests.push({ method: "GET", url: "https://api.app/orders", status: 200 });
      }
      override async observe(): Promise<Evidence> {
        return {
          execution: { actions: [], navigated: false, finalUrl: this.url, blocked: false },
          perception: {},
          logic: { requests: [...this.requests], console: [] },
        };
      }
    }
    const driver = new GetOnlyStub();
    const s = scn([
      {
        kind: "click",
        target: { text: "Place order" },
        expect: { requestStatus: { urlIncludes: "api.app/orders", status: 200, method: "POST" } },
      },
    ]);
    const { result } = await runScenario(s, { driver, reporter: silent, expectTimeoutMs: 50 });
    expect(result.evidence.execution.actions[0]?.ok).toBe(false);
  });
});
