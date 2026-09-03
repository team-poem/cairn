import { expect, it } from "vitest";
import { LlmStepHealer } from "../../src/core/step-heal.js";
import { ScriptedLlm, StubDriver } from "../support/doubles.js";
import { FakeDriver } from "../../src/adapters/drivers/fake.js";
import type { Evidence, Step } from "../../src/core/types.js";
import type { LlmClient, CompleteOptions } from "../../src/core/ports.js";

// Consolidated audit coverage.

{

  // step-heal-apply-throw.test.ts
  {
    const evidence: Evidence = {
      execution: { actions: [], navigated: true, finalUrl: "https://app/start", blocked: false },
      perception: {},
      logic: { requests: [], console: [] },
    };

    it("stepHealApplyThrowReturnsNull: when the LLM-chosen action itself fails to execute, heal returns null and records nothing", async () => {
      // The model picks "Gone", which the driver cannot act on → applyDecision throws inside heal().
      const driver = new FakeDriver({ evidence, elements: [{ role: "button", name: "Gone" }], failOn: ["Gone"] });
      const healer = new LlmStepHealer(new ScriptedLlm(['{"action":"click","text":"Gone"}']));
      const step: Step = { kind: "click", target: { text: "Checkout" }, expect: { url: "app/payment" } };
      await expect(healer.heal(step, 0, driver)).resolves.toBeNull();
      expect(healer.heals).toEqual([]);
    });
  }

  // step-heal-budget.test.ts
  {
    class CountingLlm implements LlmClient {
      readonly id = "counting";
      calls = 0;
      async complete(): Promise<string> {
        this.calls++;
        return '{"action":"click","text":"Checkout Now"}';
      }
    }

    it("stepHealBudgetStopsLlmCalls: once maxHeals heals are recorded, further heal() calls return null WITHOUT calling the LLM", async () => {
      const driver = new StubDriver();
      driver.els = [{ role: "button", name: "Checkout Now" }];
      const llm = new CountingLlm();
      const healer = new LlmStepHealer(llm, 1);
      const step: Step = { kind: "click", target: { text: "Checkout" }, expect: { url: "app/payment" } };

      const first = await healer.heal(step, 0, driver);
      expect(first?.index).toBe(0);
      expect(llm.calls).toBe(1);

      const second = await healer.heal(step, 1, driver);
      expect(second).toBeNull();
      expect(llm.calls).toBe(1); // budget exhausted → no second LLM round-trip
      expect(healer.heals).toHaveLength(1);
    });
  }

  // step-heal-decision-missing-text.test.ts
  {
    it("stepHealDecisionMissingTextReturnsNull: a well-formed but unusable decision (click without text, or a note) yields null, never a throw", async () => {
      const driver = new StubDriver();
      driver.els = [{ role: "button", name: "Checkout Now" }];
      const step: Step = { kind: "click", target: { text: "Checkout" }, expect: { url: "app/payment" } };

      const noText = new LlmStepHealer(new ScriptedLlm(['{"action":"click"}']));
      await expect(noText.heal(step, 0, driver)).resolves.toBeNull();

      const note = new LlmStepHealer(new ScriptedLlm(['{"action":"note","text":"the button looks disabled"}']));
      await expect(note.heal(step, 0, driver)).resolves.toBeNull();

      expect(driver.clicked).toEqual([]);
    });
  }

  // step-heal-done-reply.test.ts
  {
    it("stepHealDoneReplyReturnsNull: an explicit {action:done} means nothing on the page can achieve the goal, so no heal is recorded", async () => {
      const driver = new StubDriver();
      driver.els = [{ role: "button", name: "Unrelated" }];
      const healer = new LlmStepHealer(new ScriptedLlm(['{"action":"done"}']));
      const step: Step = { kind: "click", target: { text: "Checkout" }, expect: { url: "app/payment" } };
      await expect(healer.heal(step, 3, driver)).resolves.toBeNull();
      expect(healer.heals).toHaveLength(0);
      expect(driver.clicked).toEqual([]);
    });
  }

  // step-heal-keeps-intent-expect.test.ts
  {
    it("stepHealKeepsIntentAndExpect: the re-frozen step carries the ORIGINAL intent and expect so it stays verifiable next replay", async () => {
      const driver = new StubDriver();
      driver.els = [{ role: "button", name: "Checkout Now" }];
      const healer = new LlmStepHealer(new ScriptedLlm(['{"action":"click","text":"Checkout Now"}']));
      const step: Step = { kind: "click", target: { text: "Checkout" }, intent: "go to payment", expect: { url: "app/payment" } };

      const heal = await healer.heal(step, 2, driver);

      expect(heal).toEqual({
        index: 2,
        step: { kind: "click", target: { text: "Checkout Now" }, intent: "go to payment", expect: { url: "app/payment" } },
      });
      expect(driver.clicked).toEqual(["Checkout Now"]); // the corrective action actually ran
      expect(healer.heals).toEqual([heal]);
    });
  }

  // step-heal-malformed-reply.test.ts
  {
    it("stepHealMalformedReplyReturnsNull: a garbage heal reply yields null and records no heal, instead of throwing", async () => {
      const driver = new StubDriver();
      driver.els = [{ role: "button", name: "Checkout Now" }];
      const healer = new LlmStepHealer(new ScriptedLlm(["I would click the checkout button, no JSON here"]));
      const step: Step = { kind: "click", target: { text: "Checkout" }, intent: "go to payment", expect: { url: "app/payment" } };
      await expect(healer.heal(step, 0, driver)).resolves.toBeNull();
      expect(healer.heals).toEqual([]);
      expect(driver.clicked).toEqual([]); // nothing was re-dispatched from a reply that never parsed
    });
  }

  // step-heal-prompt-content.test.ts
  {
    class RecordingLlm implements LlmClient {
      readonly id = "recording";
      prompts: string[] = [];
      systems: (string | undefined)[] = [];
      async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
        this.prompts.push(prompt);
        this.systems.push(opts?.system);
        return '{"action":"done"}';
      }
    }

    it("stepHealPromptContent: the heal prompt states the step goal, the JSON expect and the live elements, falling back to kind / '(reach the next state)'", async () => {
      const driver = new StubDriver();
      driver.els = [{ role: "button", name: "Checkout Now" }];
      const llm = new RecordingLlm();
      const healer = new LlmStepHealer(llm);

      const withMeta: Step = { kind: "click", target: { text: "Checkout" }, intent: "go to payment", expect: { url: "app/payment" } };
      await healer.heal(withMeta, 0, driver);
      expect(llm.prompts[0]).toContain("Step goal: go to payment");
      expect(llm.prompts[0]).toContain('Expected outcome: {"url":"app/payment"}');
      expect(llm.prompts[0]).toContain("- [button] Checkout Now");
      expect(llm.systems[0]).toMatch(/repair ONE step/);

      const bare: Step = { kind: "pressKey", key: "Enter" };
      await healer.heal(bare, 1, driver);
      expect(llm.prompts[1]).toContain("Step goal: pressKey"); // no intent → the kind names the goal
      expect(llm.prompts[1]).toContain("Expected outcome: (reach the next state)");
    });
  }

}
