import { describe, expect, it } from "vitest";
import { discover, parseDecision } from "./discover.js";
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

    expect(scenario.steps).toEqual([
      { kind: "goto", url: "https://shop" },
      { kind: "click", target: { text: "Add to cart" } },
      { kind: "click", target: { text: "Checkout" } },
    ]);
    // assertions are grounded in observed evidence (navigated:true here), not the LLM's guess
    expect(scenario.assertions).toEqual([{ kind: "no-failed-requests" }, { kind: "navigated" }]);
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
    expect(scenario.steps).toEqual([{ kind: "click", target: { text: "Open" } }]);
    expect(driver.clicked).toEqual([{ text: "Open" }]);
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
});
