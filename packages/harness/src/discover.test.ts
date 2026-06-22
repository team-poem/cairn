import { describe, expect, it } from "vitest";
import { discover, parseDecision } from "./discover.js";
import { FakeDriver } from "./drivers/fake.js";
import type { LlmClient } from "./llm/client.js";
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
    expect(scenario.assertions).toEqual([{ kind: "navigated" }, { kind: "no-failed-requests" }]);
    expect(driver.clicked).toHaveLength(2);
  });

  it("drops malformed assertions back to a safe default", async () => {
    const driver = new FakeDriver({ evidence, elements: [] });
    const llm = new ScriptedLlm(['{"action":"done","assertions":[{"kind":"bogus"}]}']);
    const scenario = await discover("noop", { driver, llm });
    expect(scenario.assertions).toEqual([{ kind: "no-failed-requests" }]);
  });
});
