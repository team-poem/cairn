import { describe, expect, it, vi } from "vitest";
import { SelfHealingDriver, parseHealChoice } from "./self-heal.js";
import { FakeDriver } from "./fake.js";
import type { LlmClient } from "../../core/ports.js";
import type { Evidence } from "../../core/types.js";

class ScriptedLlm implements LlmClient {
  readonly id = "scripted";
  calls = 0;
  constructor(private readonly reply: string) {}
  async complete(): Promise<string> {
    this.calls++;
    return this.reply;
  }
}

const evidence: Evidence = {
  execution: { actions: [], navigated: true, finalUrl: "https://x", blocked: false },
  perception: {},
  logic: { requests: [], console: [] },
};

describe("parseHealChoice", () => {
  it("returns the chosen name", () => {
    expect(parseHealChoice('{"name":"Learn more"}')).toBe("Learn more");
  });
  it("returns undefined for an explicit null", () => {
    expect(parseHealChoice('{"name":null}')).toBeUndefined();
  });
});

describe("SelfHealingDriver", () => {
  it("heals a stale target by retrying the LLM-chosen element", async () => {
    // The frozen skill says "Read more", but only "Learn more" exists now.
    const inner = new FakeDriver({
      evidence,
      elements: [{ role: "link", name: "Learn more" }],
      failOn: ["Read more"],
    });
    const llm = new ScriptedLlm('{"name":"Learn more"}');
    const driver = new SelfHealingDriver(inner, llm);

    await driver.click({ text: "Read more" });

    expect(inner.clicked).toEqual([{ text: "Learn more" }]); // retried with healed target
    expect(driver.heals).toEqual([{ original: { text: "Read more" }, healedText: "Learn more" }]);
    expect(llm.calls).toBe(1);
  });

  it("does NOT call the LLM when the target resolves (healthy replay stays deterministic)", async () => {
    const inner = new FakeDriver({ evidence, elements: [{ role: "link", name: "Learn more" }] });
    const llm = new ScriptedLlm('{"name":"x"}');
    const spy = vi.spyOn(llm, "complete");
    const driver = new SelfHealingDriver(inner, llm);

    await driver.click({ text: "Learn more" });

    expect(spy).not.toHaveBeenCalled();
    expect(driver.heals).toHaveLength(0);
  });

  it("throws when the LLM finds no match", async () => {
    const inner = new FakeDriver({ evidence, elements: [], failOn: ["Gone"] });
    const llm = new ScriptedLlm('{"name":null}');
    const driver = new SelfHealingDriver(inner, llm);
    await expect(driver.click({ text: "Gone" })).rejects.toThrow(/found no match/);
  });
});
