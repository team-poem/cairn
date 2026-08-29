import { describe, expect, it } from "vitest";
import { applyHeals, needsLlmCritic, runScenario } from "../src/run.js";
import { FakeDriver } from "../src/adapters/drivers/fake.js";
import { ScriptedLlm, StubDriver } from "./support/doubles.js";
import { startTrace } from "../src/core/trace.js";
import type { TraceEvent } from "../src/core/trace.js";
import type { Evidence, Reporter, Result, Scenario, Step, StepProgress, Target, TraceSink } from "../src/index.js";

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

  it("threads localePrefixes from RunScenarioOptions into the final navigated verdict, not just step expects (#86 follow-up)", async () => {
    // "xx" is not in the engine's default locale list — pipeline.test.ts covers this for the
    // per-step expect precheck; this covers the same injection reaching the AssertionCritic's
    // navigated assertion, so a run's replay checks and its final verdict agree on one URL.
    const at = (finalUrl: string): Evidence => ({
      execution: { actions: [], navigated: true, finalUrl, blocked: false },
      perception: {},
      logic: { requests: [], console: [] },
    });
    const locale: Scenario = {
      name: "locale-navigated",
      steps: [{ kind: "goto", url: "https://app.co/xx/cart" }],
      assertions: [{ kind: "navigated", to: "app.co/en/cart" }],
    };

    const withInjection = new FakeDriver({ evidence: at("https://app.co/xx/cart") });
    const { result: r1 } = await runScenario(locale, { driver: withInjection, localePrefixes: ["en", "xx"] });
    expect(r1.verdict.passed).toBe(true);

    const withoutInjection = new FakeDriver({ evidence: at("https://app.co/xx/cart") });
    const { result: r2 } = await runScenario(locale, { driver: withoutInjection });
    expect(r2.verdict.passed).toBe(false); // "xx" is a real route under the default list
  });

  it("aborts between steps when the signal fires (a host's Stop button)", async () => {
    const driver = new FakeDriver({ evidence: evidence() });
    const ac = new AbortController();
    ac.abort();
    await expect(runScenario(scenario, { driver, signal: ac.signal })).rejects.toThrow();
    expect(driver.closed).toBe(false); // caller-supplied → caller closes, even on abort (#98)
  });

  it("outcome-heal judges only the re-discovery's own evidence, not the failed run's (#78)", async () => {
    // The 200 for iana.org was captured by the ORIGINAL failed run (FakeDriver's log is cumulative
    // and static). Without the watermark it would satisfy the request-status after re-discovery.
    const driver = new FakeDriver({ evidence: evidence(), elements: [] });
    const broken: Scenario = {
      name: "reach the moon",
      steps: [{ kind: "goto", url: "https://example.com" }],
      assertions: [
        { kind: "navigated", to: "the-moon" }, // always fails → triggers outcome-heal
        { kind: "request-status", urlIncludes: "iana.org", status: 200 }, // stale-satisfiable
      ],
    };
    let i = 0;
    const replies = ['{"action":"done"}', "[]"];
    const llm = { id: "scripted", async complete() { return replies[i++] ?? '{"action":"done"}'; } };

    const { result } = await runScenario(broken, { driver, llm, heal: true });

    const rs = result.verdict.results.find((r) => r.assertion.kind === "request-status");
    expect(rs?.passed).toBe(false);
    expect(rs?.detail).toContain("no request matching");
  });

  it("threads the run policy into the outcome-heal re-discovery (#76)", async () => {
    const driver = new FakeDriver({ evidence: evidence(), elements: [] });
    const broken: Scenario = {
      name: "reach the moon",
      steps: [{ kind: "goto", url: "https://example.com" }],
      assertions: [{ kind: "navigated", to: "the-moon" }],
    };
    const llm = { id: "scripted", async complete() { return "[]"; } };
    let stopped = 0;
    await runScenario(broken, {
      driver, llm, heal: true,
      policy: { vet: () => ({ ok: true }), stop: () => (stopped++, true) },
    });
    expect(stopped).toBeGreaterThan(0); // the policy reached the unattended re-discovery
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

// --- lifecycle event stream (spec/core/trace.md) -------------------------------------------------

class RecordingSink implements TraceSink {
  events: TraceEvent[] = [];
  emit(e: TraceEvent): void {
    this.events.push(e);
  }
}

describe("runScenario trace", () => {
  it("a bare green replay emits the full lifecycle in order with monotonic seq", async () => {
    const sink = new RecordingSink();
    const driver = new FakeDriver({ evidence: evidence() });
    const traced: Scenario = {
      ...scenario,
      assertions: [{ kind: "navigated", origin: "derived" }, { kind: "no-failed-requests" }],
    };
    await runScenario(traced, { driver, reporter: silent, trace: sink });

    expect(sink.events.map((e) => e.kind)).toEqual([
      "trace", "case-start", "step", "step", "assertion", "assertion", "case-end", "run-end",
    ]);
    expect(sink.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    const header = sink.events[0]!;
    expect(header.phase).toBeUndefined();
    if (header.kind === "trace") expect(header.payload.engine.name).toBe("cairn");

    // implicit case: caseRef = scenario name on every case-scoped event
    expect(sink.events[1]).toMatchObject({
      kind: "case-start",
      caseRef: traced.name,
      payload: { id: traced.name, intent: traced.name, cached: true },
    });
    expect(sink.events[2]).toMatchObject({ phase: "replay", caseRef: traced.name, stepRef: 0 });
    expect(sink.events[3]).toMatchObject({ phase: "replay", stepRef: 1 });

    // origin rides through; absent origin surfaces as unknown, never guessed
    expect(sink.events[4]!.payload).toMatchObject({ origin: "derived", checkedBy: "code", passed: true });
    expect(sink.events[5]!.payload).toMatchObject({ origin: "unknown", checkedBy: "code" });

    expect(sink.events[6]!.payload).toMatchObject({ discovered: false, heals: 0 });
    expect(sink.events[6]!.phase).toBeUndefined();
    expect(sink.events[7]!.payload).toMatchObject({ passed: true });
  });

  it("a suite-scoped run emits NO header/case events — only step/assertion into the given scope", async () => {
    const sink = new RecordingSink();
    const scope = startTrace(sink, "0.0.0").scope("case-7");
    const driver = new FakeDriver({ evidence: evidence() });
    await runScenario(scenario, { driver, reporter: silent, traceScope: scope });

    expect(sink.events.map((e) => e.kind)).toEqual(["trace", "step", "step", "assertion", "assertion"]);
    for (const e of sink.events.slice(1)) expect(e.caseRef).toBe("case-7");
  });

  it("a locator heal emits heal{layer:locator} under phase heal", async () => {
    const sink = new RecordingSink();
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
    const llm = new ScriptedLlm(['{"name":"Learn more"}']);
    await runScenario(broken, { driver, llm, heal: true, reporter: silent, trace: sink });

    const heal = sink.events.find((e) => e.kind === "heal");
    expect(heal).toMatchObject({ phase: "heal" });
    expect(heal!.payload).toMatchObject({
      layer: "locator",
      broke: { text: "Read more" },
      became: { text: "Learn more", role: "link", index: 0 },
      judgedBy: "original",
    });
  });

  it("a surgical step heal emits heal{layer:step} with the step's index", async () => {
    const sink = new RecordingSink();
    const driver = new StubDriver();
    driver.els = [{ role: "button", name: "Checkout Now" }];
    driver.navOn["Checkout Now"] = "https://app/payment";
    const llm = new ScriptedLlm(['{"action":"click","text":"Checkout Now"}']);
    const s = scn([
      { kind: "click", target: { text: "Checkout" }, intent: "go to payment", expect: { url: "app/payment" } },
    ]);
    await runScenario(s, { driver, llm, heal: true, reporter: silent, expectTimeoutMs: 50, trace: sink });

    const heal = sink.events.find((e) => e.kind === "heal");
    expect(heal).toMatchObject({ phase: "heal", stepRef: 0 });
    expect(heal!.payload).toMatchObject({
      layer: "step",
      broke: { kind: "click", target: { text: "Checkout" } },
      became: { kind: "click", target: { text: "Checkout Now" } },
      judgedBy: "original",
    });
    // the step event records what actually ran — the healed step, ok
    const step = sink.events.find((e) => e.kind === "step");
    expect(step!.payload).toMatchObject({ step: { target: { text: "Checkout Now" } }, ok: true });
  });

  it("outcome-heal re-discovery emits discover kinds and the re-judged assertions under phase heal", async () => {
    const sink = new RecordingSink();
    const driver = new FakeDriver({ evidence: evidence(), elements: [] });
    const broken: Scenario = {
      name: "reach the moon",
      steps: [{ kind: "goto", url: "https://example.com" }],
      assertions: [{ kind: "navigated", to: "the-moon" }],
    };
    const llm = new ScriptedLlm(['{"action":"done"}', "[]"]);
    await runScenario(broken, { driver, llm, heal: true, reporter: silent, trace: sink });

    const actions = sink.events.filter((e) => e.kind === "action");
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) expect(a.phase).toBe("heal");

    const assertionPhases = sink.events.filter((e) => e.kind === "assertion").map((e) => e.phase);
    expect(new Set(assertionPhases)).toEqual(new Set(["replay", "heal"]));

    // bare mode still closes the trace on the outcome-heal return path
    expect(sink.events.at(-2)!.kind).toBe("case-end");
    expect(sink.events.at(-1)!).toMatchObject({ kind: "run-end", payload: { passed: false } });
  });

  it("a throwing sink changes nothing: the verdict is identical to a run without trace", async () => {
    const driver = new FakeDriver({ evidence: evidence() });
    const bomb: TraceSink = {
      emit: () => {
        throw new Error("boom");
      },
    };
    const { result } = await runScenario(scenario, { driver, reporter: silent, trace: bomb });
    expect(result.verdict.passed).toBe(true);
  });

  it("emits nothing and behaves identically without a trace option", async () => {
    const driver = new FakeDriver({ evidence: evidence() });
    const { result } = await runScenario(scenario, { driver, reporter: silent });
    expect(result.verdict.passed).toBe(true);
  });
});

describe("the wildcard notation is declared by the file, not assumed (#182 review)", () => {
  const at = (finalUrl: string): Evidence => ({
    execution: { actions: [], navigated: true, finalUrl, blocked: false },
    perception: {},
    logic: { requests: [], console: [] },
  });
  const wildcarded: Scenario = {
    name: "order → done",
    steps: [{ kind: "goto", url: "https://shop.co/cart" }],
    assertions: [{ kind: "navigated", to: "shop.co/orders/*/done" }],
  };

  it("a freeze that declared it matches any id in that segment", async () => {
    const driver = new FakeDriver({ evidence: at("https://shop.co/orders/999001/done") });
    const { result } = await runScenario({ ...wildcarded, wildcards: true }, { driver });
    expect(result.verdict.passed).toBe(true);
  });

  it("a file frozen before the notation keeps its * literal", async () => {
    // Same assertion, no marker: the page's path really contains a star, so a different id is not
    // that page and the check must fail rather than quietly widen.
    const driver = new FakeDriver({ evidence: at("https://shop.co/orders/999001/done") });
    const { result } = await runScenario(wildcarded, { driver });
    expect(result.verdict.passed).toBe(false);

    const exact = new FakeDriver({ evidence: at("https://shop.co/orders/*/done") });
    const { result: r2 } = await runScenario(wildcarded, { driver: exact });
    expect(r2.verdict.passed).toBe(true);
  });
});
