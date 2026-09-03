import { describe, expect, it, vi } from "vitest";
import { SelfHealingDriver, parseHealChoice } from "../../../src/adapters/drivers/self-heal.js";
import { FakeDriver } from "../../../src/adapters/drivers/fake.js";
import type { LlmClient } from "../../../src/core/ports.js";
import type { Evidence } from "../../../src/core/types.js";

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

    // retried with a re-located target carrying role/index, not a brittle text-only one (P5)
    expect(inner.clicked).toEqual([{ text: "Learn more", role: "link", index: 0 }]);
    expect(driver.heals).toEqual([
      { original: { text: "Read more" }, healed: { text: "Learn more", role: "link", index: 0 } },
    ]);
    expect(llm.calls).toBe(1);
  });

  it("fires onHeal so a host can flag the aging scenario", async () => {
    const inner = new FakeDriver({ evidence, elements: [{ role: "link", name: "Learn more" }], failOn: ["Read more"] });
    const seen: string[] = [];
    const driver = new SelfHealingDriver(inner, new ScriptedLlm('{"name":"Learn more"}'), {
      onHeal: (h) => seen.push(`${h.original.text}→${h.healed.text}`),
    });
    await driver.click({ text: "Read more" });
    expect(seen).toEqual(["Read more→Learn more"]);
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

import type { CompleteOptions, Driver } from "../../../src/core/ports.js";
import type { PageElement, Target } from "../../../src/core/types.js";

// Consolidated audit coverage.

{

  const evidence: Evidence = {
    execution: { actions: [], navigated: true, finalUrl: "https://x", blocked: false },
    perception: {},
    logic: { requests: [], console: [] },
  };

  // self-heal-budget-exhausted.test.ts
  {
    it("selfHealBudgetExhaustedThrows: past maxHeals a broken target throws a budget error naming the target, with no further LLM call", async () => {
      const inner = new FakeDriver({ evidence, elements: [{ role: "link", name: "Z" }], failOn: ["A", "B"] });
      let calls = 0;
      const llm = { id: "scripted", async complete() { calls++; return '{"name":"Z"}'; } };
      const driver = new SelfHealingDriver(inner, llm, { maxHeals: 1 });

      await driver.click({ text: "A" }); // first heal fits the budget
      expect(calls).toBe(1);

      await expect(driver.click({ text: "B" })).rejects.toThrow('self-heal budget (1) exhausted for {"text":"B"}');
      expect(calls).toBe(1);
      expect(driver.heals).toHaveLength(1);
    });
  }

  // self-heal-budget-zero.test.ts
  {
    it("selfHealBudgetZeroNeverCallsLlm: maxHeals 0 turns the decorator into a pass-through that throws on the first break without touching the LLM", async () => {
      const inner = new FakeDriver({ evidence, elements: [{ role: "link", name: "Z" }], failOn: ["A"] });
      let calls = 0;
      const llm = { id: "scripted", async complete() { calls++; return '{"name":"Z"}'; } };
      const driver = new SelfHealingDriver(inner, llm, { maxHeals: 0 });

      await expect(driver.click({ text: "A" })).rejects.toThrow(/self-heal budget \(0\) exhausted/);
      expect(calls).toBe(0);
      expect(inner.clicked).toEqual([]);
    });
  }

  // self-heal-double-click-hover.test.ts
  {
    const llm = { id: "scripted", async complete() { return '{"name":"New"}'; } };

    it("selfHealDoubleClickAndHoverRedispatchHealed: doubleClick and hover retry the inner driver with the re-located healed target", async () => {
      const inner = new FakeDriver({ evidence, elements: [{ role: "button", name: "New" }], failOn: ["Old"] });
      const driver = new SelfHealingDriver(inner, llm);

      await driver.doubleClick({ text: "Old" });
      expect(inner.clicked).toEqual([{ text: "New", role: "button", index: 0 }]);

      await driver.hover({ text: "Old" });
      expect(inner.hovered).toEqual([{ text: "New", role: "button", index: 0 }]);

      expect(driver.heals).toHaveLength(2);
    });
  }

  // self-heal-goto-presskey.test.ts
  {
    class BrokenNav extends FakeDriver {
      override async goto(): Promise<void> {
        throw new Error("net::ERR_CONNECTION_REFUSED");
      }
      override async pressKey(): Promise<void> {
        throw new Error("no focused element");
      }
    }

    it("selfHealGotoAndPressKeyAreNotHealed: target-less methods propagate their failure untouched — no LLM call, no heal record", async () => {
      let calls = 0;
      const llm = { id: "scripted", async complete() { calls++; return '{"name":"x"}'; } };
      const driver = new SelfHealingDriver(new BrokenNav({ evidence, elements: [{ role: "link", name: "x" }] }), llm);
      await expect(driver.goto("https://x")).rejects.toThrow("net::ERR_CONNECTION_REFUSED");
      await expect(driver.pressKey("Enter")).rejects.toThrow("no focused element");
      expect(calls).toBe(0);
      expect(driver.heals).toEqual([]);
    });
  }

  // self-heal-no-match-cause.test.ts
  {
    it("selfHealNoMatchErrorCarriesCause: the no-match error names the target and embeds the original failure message, and nothing is recorded as healed", async () => {
      const inner = new FakeDriver({ evidence, elements: [], failOn: ["Gone"] });
      const llm = { id: "scripted", async complete() { return '{"name":null}'; } };
      const driver = new SelfHealingDriver(inner, llm);
      await expect(driver.click({ text: "Gone" })).rejects.toThrow('self-heal found no match for {"text":"Gone"} (element not found: Gone)');
      expect(driver.heals).toEqual([]);
    });
  }

  // self-heal-parse-choice-edges.test.ts
  {
    it("selfHealParseChoiceEdges: a blank or non-string name means 'none', prose around the JSON is tolerated, and a reply with no JSON throws", () => {
      expect(parseHealChoice('{"name":"   "}')).toBeUndefined();
      expect(parseHealChoice('{"name":42}')).toBeUndefined();
      expect(parseHealChoice("{}")).toBeUndefined();
      expect(parseHealChoice('Sure! {"name":"Learn more"} is the best fit.')).toBe("Learn more");
      expect(() => parseHealChoice("I cannot decide")).toThrow(/no JSON in heal reply/);
    });
  }

  // self-heal-prompt-caps.test.ts
  {
    class RecordingLlm implements LlmClient {
      readonly id = "recording";
      prompts: string[] = [];
      systems: (string | undefined)[] = [];
      async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
        this.prompts.push(prompt);
        this.systems.push(opts?.system);
        return '{"name":null}';
      }
    }

    it("selfHealPromptCapsAt60AndNoneFallback: the heal prompt lists at most 60 '- [role] name' lines, says '(none)' for an empty page, and carries the repair system prompt", async () => {
      const many: PageElement[] = Array.from({ length: 70 }, (_, i) => ({ role: "link", name: `e${i}` }));
      const llm = new RecordingLlm();

      const crowded = new SelfHealingDriver(new FakeDriver({ evidence, elements: many, failOn: ["Old"] }), llm);
      await expect(crowded.click({ text: "Old" })).rejects.toThrow(/found no match/);
      expect(llm.prompts[0]).toContain("Original target: Old");
      expect(llm.prompts[0]).toContain("- [link] e59");
      expect(llm.prompts[0]).not.toContain("- [link] e60");
      expect(llm.prompts[0]?.match(/^- \[link\] /gm)).toHaveLength(60);
      expect(llm.systems[0]).toMatch(/repair a broken browser test step/);

      const empty = new SelfHealingDriver(new FakeDriver({ evidence, elements: [], failOn: ["Old"] }), llm);
      await expect(empty.click({ text: "Old" })).rejects.toThrow(/found no match/);
      expect(llm.prompts[1]).toContain("Current interactive elements:\n(none)");
    });
  }

  // self-heal-prompt-target-label.test.ts
  {
    /** A driver that rejects EVERY click, so selector-only and empty targets also reach the healer. */
    class AlwaysBroken extends FakeDriver {
      override async click(_target: Target): Promise<void> {
        throw new Error("element not found");
      }
    }

    class RecordingLlm implements LlmClient {
      readonly id = "recording";
      prompts: string[] = [];
      async complete(prompt: string): Promise<string> {
        this.prompts.push(prompt);
        return '{"name":null}';
      }
    }

    it("selfHealPromptTargetLabelChain: the prompt names the target by text, else selector, else '(unknown)'", async () => {
      const llm = new RecordingLlm();
      const driver: Driver = new SelfHealingDriver(new AlwaysBroken({ evidence, elements: [] }), llm);

      await expect(driver.click({ text: "Read more", selector: "#rm" })).rejects.toThrow(/found no match/);
      await expect(driver.click({ selector: "#rm" })).rejects.toThrow(/found no match/);
      await expect(driver.click({ role: "link", index: 2 })).rejects.toThrow(/found no match/);

      expect(llm.prompts.map((p) => p.split("\n")[0])).toEqual([
        "Original target: Read more",
        "Original target: #rm",
        "Original target: (unknown)",
      ]);
    });
  }

  // self-heal-type-select.test.ts
  {
    class RecordingFake extends FakeDriver {
      typed: [Target, string][] = [];
      selected: [Target, string][] = [];
      override async type(target: Target, text: string): Promise<void> {
        await super.type(target, text);
        this.typed.push([target, text]);
      }
      override async select(target: Target, value: string): Promise<void> {
        await super.select(target, value);
        this.selected.push([target, value]);
      }
    }

    it("selfHealTypeAndSelectKeepValue: type and select retry with the healed target AND the original text/value", async () => {
      const inner = new RecordingFake({ evidence, elements: [{ role: "textbox", name: "Email address" }], failOn: ["Email"] });
      const llm = { id: "scripted", async complete() { return '{"name":"Email address"}'; } };
      const driver = new SelfHealingDriver(inner, llm);

      await driver.type({ text: "Email" }, "a@b.co");
      expect(inner.typed).toEqual([[{ text: "Email address", role: "textbox", index: 0 }, "a@b.co"]]);

      await driver.select({ text: "Email" }, "KR");
      expect(inner.selected).toEqual([[{ text: "Email address", role: "textbox", index: 0 }, "KR"]]);
    });
  }

}
