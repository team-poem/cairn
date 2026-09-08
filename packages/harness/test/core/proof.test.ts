import { describe, expect, it } from "vitest";
import { finalizeVerdict, proofOf } from "../../src/core/pipeline.js";
import { provesAnAction } from "../../src/core/freeze.js";
import { runScenario } from "../../src/run.js";
import { FakeDriver } from "../../src/adapters/drivers/fake.js";
import { ConsoleReporter } from "../../src/adapters/reporters/console.js";
import { renderSuiteReport } from "../../src/adapters/reporters/suite.js";
import type { Assertion, AssertionResult, Evidence, Scenario, Verdict } from "../../src/core/types.js";
import type { SuiteResult } from "../../src/suite.js";
import { vi } from "vitest";

const nav = (extra: Partial<Extract<Assertion, { kind: "navigated" }>> = {}): Assertion => ({ kind: "navigated", to: "shop.co/done", ...extra });
const req = (extra: Partial<Assertion> = {}): Assertion => ({ kind: "request-status", urlIncludes: "/api/orders", status: 200, ...extra } as Assertion);
const green = (assertions: Assertion[]): Verdict => ({ passed: true, results: assertions.map((assertion): AssertionResult => ({ assertion, passed: true })) });

describe("proofOf grades what a set of checks can prove (#197)", () => {
  it("work: a live request-status or custom check saw the action happen", () => {
    expect(proofOf([nav(), req()]).grade).toBe("work");
    expect(proofOf([{ kind: "custom", name: "stock" }]).grade).toBe("work");
    expect(proofOf([nav(), req()])).toMatchObject({ work: 1, arrival: 1, discriminating: 2, vacuous: 0, guards: 0 });
  });

  it("judged: an LLM said so, nothing mechanical did; arrival: only a destination held", () => {
    expect(proofOf([{ kind: "expect", criterion: "the order is confirmed" }]).grade).toBe("judged");
    expect(proofOf([nav(), { kind: "expect", criterion: "c" }]).grade).toBe("judged"); // outranks arrival
    expect(proofOf([req(), { kind: "expect", criterion: "c" }]).grade).toBe("work"); // never outranks proof
    expect(proofOf([nav()]).grade).toBe("arrival");
    expect(proofOf([nav(), { kind: "no-failed-requests" }])).toMatchObject({ grade: "arrival", arrival: 1, guards: 1 });
  });

  it("a request-status on a GET still counts as work — the same blind spot as provesAnAction, kept on purpose", () => {
    const get: Assertion = { kind: "request-status", urlIncludes: "/api/me", status: 200, method: "GET" };
    expect(proofOf([get]).grade).toBe("work");
    expect(provesAnAction({ name: "s", steps: [], assertions: [get] })).toBe(true);
  });

  it("none: nothing here would fail on a broken flow", () => {
    expect(proofOf([{ kind: "no-failed-requests" }, { kind: "no-console-errors" }])).toMatchObject({ grade: "none", guards: 2, discriminating: 0, vacuous: 0 });
    expect(proofOf([{ kind: "navigated" }]).grade).toBe("none"); // bare, no destination
    expect(proofOf([]).grade).toBe("none");
  });

  it("a vacuous check counts for nothing — the strongest kind, once stamped, drops the grade", () => {
    expect(proofOf([nav(), req({ vacuous: true })])).toMatchObject({ grade: "arrival", work: 0, vacuous: 1, discriminating: 1 });
    expect(proofOf([nav({ vacuous: true }), req({ vacuous: true })])).toMatchObject({ grade: "none", discriminating: 0, vacuous: 2 });
  });

  it("guards are counted by kind, never as vacuous — #137 stamps them on a clean start, a 500 still trips them", () => {
    const stamped = [{ kind: "no-failed-requests", vacuous: true }, { kind: "no-console-errors", vacuous: true }, nav(), req()] as Assertion[];
    expect(proofOf(stamped)).toMatchObject({ grade: "work", guards: 2, vacuous: 0, discriminating: 2 });
  });

  it("carries the freeze's unproven action", () => {
    expect(proofOf([nav()], "POST https://shop.co/api/orders").unprovenAction).toBe("POST https://shop.co/api/orders");
    expect(proofOf([nav()])).not.toHaveProperty("unprovenAction");
  });

  it("work is exactly provesAnAction, on every shape", () => {
    const shapes: Assertion[][] = [[nav(), req()], [nav()], [req({ vacuous: true })], [{ kind: "custom", name: "x" }], [{ kind: "expect", criterion: "c" }], []];
    for (const assertions of shapes) {
      expect(proofOf(assertions).grade === "work").toBe(provesAnAction({ name: "s", steps: [], assertions }));
    }
  });
});

describe("the finalizer stamps proof on a green and never on a red", () => {
  it("green gets proof, red gets failure, neither gets both", () => {
    const g = finalizeVerdict(green([nav(), req()]), undefined, [], { unprovenAction: "PUT https://shop.co/api/cart" });
    expect(g.proof).toMatchObject({ grade: "work", unprovenAction: "PUT https://shop.co/api/cart" });
    expect(g).not.toHaveProperty("failure");
    const r = finalizeVerdict({ passed: false, results: [{ assertion: nav(), passed: false, detail: "…" }] });
    expect(r.failure).toBe("flow");
    expect(r).not.toHaveProperty("proof");
    expect(finalizeVerdict(green([nav()]), "step 2/2 blocked: …")).not.toHaveProperty("proof"); // failed closed → red
  });
});

describe("proof rides the real paths (#197)", () => {
  const evidence: Evidence = {
    execution: { actions: [], navigated: true, finalUrl: "https://shop.co/done", blocked: false },
    perception: {},
    logic: { requests: [{ method: "POST", url: "https://shop.co/api/orders", status: 201 }], console: [] },
  };
  const silent = { emit: async () => {} };
  const scenario = (assertions: Assertion[], unprovenAction?: string): Scenario => ({
    name: "buy", steps: [{ kind: "goto", url: "https://shop.co/" }], assertions, ...(unprovenAction ? { unprovenAction } : {}),
  });

  it("a replay's green says what it proves, and carries the freeze's unproven action", async () => {
    const work = await runScenario(scenario([nav(), { kind: "request-status", urlIncludes: "/api/orders", status: 201 }]), { driver: new FakeDriver({ evidence }), reporter: silent });
    expect(work.result.verdict.proof).toMatchObject({ grade: "work", work: 1, arrival: 1 });
    const arrival = await runScenario(scenario([nav()], "DELETE https://shop.co/api/cart/7"), { driver: new FakeDriver({ evidence }), reporter: silent });
    expect(arrival.result.verdict.proof).toMatchObject({ grade: "arrival", unprovenAction: "DELETE https://shop.co/api/cart/7" });
  });

  it("a heal's green is graded from the ORIGINAL assertions and carries the original's unproven action", async () => {
    const { ScriptedLlm, StubDriver } = await import("../support/doubles.js");
    class Shop extends StubDriver {
      requests: { method: string; url: string; status: number }[] = [];
      override async click(t: { text?: string }) {
        await super.click(t as never);
        if (t.text === "Pay") this.requests.push({ method: "POST", url: "https://shop.co/api/orders", status: 201 });
      }
      override async observe() { const e = await super.observe(); return { ...e, logic: { ...e.logic, requests: this.requests } }; }
    }
    const driver = new Shop("https://shop.co/");
    driver.els = [{ role: "button", name: "Pay" }];
    driver.navOn.Pay = "https://shop.co/done";
    const original: Scenario = {
      name: "buy",
      steps: [{ kind: "goto", url: "https://shop.co/" }, { kind: "click", target: { text: "Old" } }],
      assertions: [nav(), { kind: "request-status", urlIncludes: "/api/orders", status: 201 }],
      unprovenAction: "PUT https://shop.co/api/cart",
    };
    const { result, healedScenario } = await runScenario(original, {
      driver, heal: true, reporter: silent,
      llm: new ScriptedLlm(['{"action":"click","text":"Pay"}', '{"action":"done"}', "[]"]),
    });
    expect(result.verdict.passed).toBe(true);
    expect(result.verdict.proof).toMatchObject({ grade: "work", unprovenAction: "PUT https://shop.co/api/cart" });
    expect(healedScenario?.unprovenAction).toBe("PUT https://shop.co/api/cart");
  });

  it("the console reporter says the grade on the pass line", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(String(line)); });
    try {
      await new ConsoleReporter().emit({ scenario: "buy", context: { intent: "buy" } as never, evidence, verdict: finalizeVerdict(green([nav()]), undefined, [], { unprovenAction: "POST https://shop.co/api/orders" }) });
    } finally { spy.mockRestore(); }
    expect(lines.at(-1)).toContain("proves arrival only");
    expect(lines.at(-1)).toContain("unproven: POST https://shop.co/api/orders");
  });

  it("the suite report marks a pass that proves arrival only, or nothing", () => {
    const row = (id: string, assertions: Assertion[]) => ({
      id, intent: id, discovered: false, heals: 0, usage: { llmCalls: 0, measuredCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      verdict: finalizeVerdict(green(assertions)),
    });
    const usage = { llmCalls: 0, measuredCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    const suite = { passed: true, usage, verdicts: [row("a", [nav(), req()]), row("b", [nav()]), row("c", [{ kind: "no-failed-requests" }])] } as unknown as SuiteResult;
    const report = renderSuiteReport(suite);
    expect(report).toMatch(/\| a \| ✓ pass \|/);
    expect(report).toContain("| b | ✓ pass (arrival only) |");
    expect(report).toContain("| c | ✓ pass (proves nothing) |");
    const judged = renderSuiteReport({ passed: true, usage, verdicts: [row("d", [{ kind: "expect", criterion: "c" }])] } as unknown as SuiteResult);
    expect(judged).toContain("| d | ✓ pass (LLM-judged) |");
  });
});
