import { describe, expect, it } from "vitest";
import { discover, parseDecision, rankElements } from "./discover.js";
import { FakeDriver } from "../adapters/drivers/fake.js";
import type { LlmClient } from "./ports.js";
import type { Evidence } from "./types.js";

/** Replays a fixed sequence of model replies — keeps discover deterministic in tests. */
class ScriptedLlm implements LlmClient {
  readonly id = "scripted";
  private i = 0;
  constructor(private readonly replies: string[]) {}
  async complete(): Promise<string> {
    return this.replies[this.i++] ?? '{"action":"done"}';
  }
}

const evidence: Evidence = {
  execution: { actions: [], navigated: true, finalUrl: "https://shop/cart", blocked: false },
  perception: {},
  logic: { requests: [], console: [] },
};

describe("parseDecision", () => {
  it("tolerates code fences and surrounding prose", () => {
    const d = parseDecision('Sure!\n```json\n{"action":"click","text":"Add to cart"}\n```');
    expect(d).toEqual({ action: "click", text: "Add to cart" });
  });
  it("takes the first object when a model emits two (real crash on complex flows)", () => {
    const d = parseDecision('{"action":"type","text":"User","value":"a"}\n{"action":"done"}');
    expect(d).toEqual({ action: "type", text: "User", value: "a" });
  });
  it("ignores braces inside string values", () => {
    expect(parseDecision('{"action":"type","text":"Name","value":"a{b}c"}')).toEqual({
      action: "type",
      text: "Name",
      value: "a{b}c",
    });
  });
});

describe("rankElements (#15)", () => {
  it("keeps an interactive, intent-relevant control inside the cutoff past a wall of noise", () => {
    const noise = Array.from({ length: 70 }, (_, i) => ({ role: "paragraph", name: `text ${i}` }));
    const ranked = rankElements([...noise, { role: "button", name: "Checkout now" }], "checkout", 60);
    // a flat slice(0, 60) would drop the button at index 70; ranking pulls it in.
    expect(ranked).toContainEqual({ role: "button", name: "Checkout now" });
    expect(ranked).toHaveLength(60);
  });

  it("boosts an intent-relevant control for a non-ASCII (Korean) intent (P8)", () => {
    const els = [
      { role: "button", name: "취소" }, // interactive, not intent-relevant
      { role: "button", name: "결제하기" }, // interactive + matches the "결제" token
    ];
    // before P8, `\W` split yielded no Korean tokens, so relevance never broke the tie
    expect(rankElements(els, "결제 진행", 60)[0]).toEqual({ role: "button", name: "결제하기" });
  });
});

describe("discover", () => {
  it("turns an intent into a Scenario via observe→act→adapt", async () => {
    const driver = new FakeDriver({
      evidence,
      elements: [
        { role: "link", name: "Add to cart" },
        { role: "button", name: "Checkout" },
      ],
    });
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Add to cart","reason":"add item"}',
      '{"action":"click","text":"Checkout","reason":"proceed"}',
      '{"action":"done","assertions":[{"kind":"navigated"},{"kind":"no-failed-requests"}]}',
    ]);

    const scenario = await discover("checkout flow", { driver, llm, baseUrl: "https://shop" });

    // targets are enriched with resilient locators (role + structural index) at freeze time;
    // the decision's reason is captured as `intent` for surgical-heal (no URL change here → no expect)
    expect(scenario.steps).toEqual([
      { kind: "goto", url: "https://shop" },
      { kind: "click", target: { text: "Add to cart", role: "link", index: 0 }, intent: "add item" },
      { kind: "click", target: { text: "Checkout", role: "button", index: 0 }, intent: "proceed" },
    ]);
    // assertions are grounded in observed evidence — navigated to the real destination, not the LLM's guess
    expect(scenario.assertions).toEqual([
      { kind: "no-failed-requests" },
      { kind: "navigated", to: "shop/cart" },
    ]);
    expect(driver.clicked).toHaveLength(2);
  });

  it("recovers from a failed action and adapts instead of crashing", async () => {
    // First pick a target that doesn't resolve; discover should not throw, but try again.
    const driver = new FakeDriver({
      evidence,
      elements: [{ role: "link", name: "Open" }],
      failOn: ["Gone"],
    });
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Gone"}',
      '{"action":"click","text":"Open"}',
      '{"action":"done"}',
    ]);

    const scenario = await discover("adapt", { driver, llm });

    // The failed click is not recorded; only the successful one is.
    expect(scenario.steps).toEqual([{ kind: "click", target: { text: "Open", role: "link", index: 0 } }]);
    expect(driver.clicked).toEqual([{ text: "Open", role: "link", index: 0 }]);
  });

  it("flags a scenario truncated at the step cap (P10)", async () => {
    const driver = new FakeDriver({ evidence, elements: [{ role: "button", name: "Next" }] });
    const llm = new ScriptedLlm(Array(5).fill('{"action":"click","text":"Next"}')); // never says done
    const scenario = await discover("loops", { driver, llm, maxSteps: 3 });
    expect(scenario.truncated).toBe(true);
    expect(scenario.steps).toHaveLength(3);
  });

  it("grounds assertions in evidence — no `navigated` on a flow that didn't navigate (SPA)", async () => {
    const spaEvidence: Evidence = {
      ...evidence,
      execution: { ...evidence.execution, navigated: false },
    };
    const driver = new FakeDriver({ evidence: spaEvidence, elements: [] });
    // LLM wrongly proposes `navigated`; grounding must drop it.
    const llm = new ScriptedLlm(['{"action":"done","assertions":[{"kind":"navigated"}]}']);
    const scenario = await discover("noop", { driver, llm });
    expect(scenario.assertions).toEqual([{ kind: "no-failed-requests" }]);
  });

  it("#16: freezes a proposed request-status only when a real request matches it", async () => {
    const ev: Evidence = {
      execution: { actions: [], navigated: true, finalUrl: "https://shop/payment", blocked: false },
      perception: {},
      logic: {
        requests: [{ method: "POST", url: "https://shop/api/orders", status: 200 }],
        console: [],
      },
    };
    const driver = new FakeDriver({ evidence: ev, elements: [{ role: "button", name: "Pay" }] });
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Pay"}',
      '{"action":"done"}',
      // proposeAssertions reply: one grounded (matches a request), one hallucinated (no match)
      '[{"kind":"request-status","urlIncludes":"/api/orders","status":200},{"kind":"request-status","urlIncludes":"/api/ghost","status":200}]',
    ]);
    const scenario = await discover("pay", { driver, llm });
    expect(scenario.assertions).toEqual([
      { kind: "no-failed-requests" },
      { kind: "navigated", to: "shop/payment" },
      { kind: "request-status", urlIncludes: "/api/orders", status: 200 },
    ]);
  });

  it("#16: freezes `expect` only when semanticChecks is on (invariant #4)", async () => {
    const replies = ['{"action":"done"}', '[{"kind":"expect","criterion":"order confirmed"}]'];
    const off = await discover("x", {
      driver: new FakeDriver({ evidence, elements: [] }),
      llm: new ScriptedLlm([...replies]),
    });
    expect(off.assertions.some((a) => a.kind === "expect")).toBe(false);

    const on = await discover("x", {
      driver: new FakeDriver({ evidence, elements: [] }),
      llm: new ScriptedLlm([...replies]),
      semanticChecks: true,
    });
    expect(on.assertions).toContainEqual({ kind: "expect", criterion: "order confirmed" });
  });
});
