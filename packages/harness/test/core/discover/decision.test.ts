import { describe, expect, it } from "vitest";
import { decisionToStep, parseDecision } from "../../../src/core/discover/decision.js";
import { StubDriver } from "../../support/doubles.js";

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

describe("decisionToStep", () => {
  it("maps a decision to a typed Step without executing it", async () => {
    const driver = new StubDriver();
    const step = await decisionToStep(driver, { action: "click", text: "Buy" });
    expect(step).toEqual({ kind: "click", target: { text: "Buy" } });
    expect(driver.clicked).toEqual([]); // mapping only — execution is applyDecision's job
  });

  it('rejects "done" — it is a loop terminator, not an executable step', async () => {
    await expect(decisionToStep(new StubDriver(), { action: "done" })).rejects.toThrow(
      "not an executable action",
    );
  });
});

describe("decision role/nth threading (#127)", () => {
  it("passes role and nth through to locate()", async () => {
    const seen: unknown[] = [];
    const driver = {
      async locate(t: unknown) { seen.push(t); return t; },
      async click() {},
    } as never;
    const { decisionToStep } = await import("../../../src/core/discover/decision.js");
    await decisionToStep(driver, { action: "click", text: "Log in", role: "button", nth: 1 });
    expect(seen[0]).toEqual({ text: "Log in", role: "button", nth: 1 });
  });
});

describe("parseDecision nth coercion (#127)", () => {
  it("coerces a quoted numeric nth so it addresses instead of silently missing", async () => {
    const { parseDecision } = await import("../../../src/core/discover/decision.js");
    const d = parseDecision('{"action":"click","text":"Log in","role":"button","nth":"1"}');
    expect(d.nth).toBe(1);
  });
  it("leaves a non-numeric nth alone (falls to the ambiguity/miss path)", async () => {
    const { parseDecision } = await import("../../../src/core/discover/decision.js");
    const d = parseDecision('{"action":"click","text":"x","nth":"last"}');
    expect(d.nth).toBe("last");
  });
});

describe("describeAmbiguity role message (#127)", () => {
  it("tells the model role may suffice, adding nth only if the role still repeats", async () => {
    const { describeAmbiguity } = await import("../../../src/core/discover/decision.js");
    const msg = describeAmbiguity(
      { action: "click", text: "Log in" },
      [
        { role: "button", name: "Log in" },
        { role: "button", name: "Log in" },
      ],
    );
    expect(msg).toContain('add "role"');
    expect(msg).toContain("if that role still repeats");
  });
});

import type { Decision } from "../../../src/core/discover/decision.js";

// Consolidated audit coverage.

{

  // decision-rejects.test.ts
  {
    describe("parseDecision rejects what it cannot act on", () => {
      it("parseDecisionRejectsMalformed: no JSON object, and an object without action, both throw with the reply quoted", () => {
        expect(() => parseDecision("I would click the button")).toThrow(/no JSON object in model reply: I would click/);
        expect(() => parseDecision('{"text":"Buy"}')).toThrow(/decision missing "action": \{"text":"Buy"\}/);
      });
    });

    describe("decisionToStep refuses an incomplete decision before the driver sees it", () => {
      const driver = new StubDriver();
      const cases: [Decision, RegExp][] = [
        [{ action: "click" }, /click decision missing "text"/],
        [{ action: "type", value: "x" }, /type decision missing "text"/],
        [{ action: "pressKey" }, /pressKey decision missing "key"/],
        [{ action: "goto" }, /goto decision missing "url"/],
        [{ action: "waitFor" }, /waitFor decision missing "until"/],
        [{ action: "note", text: "confusing" }, /"note" is not an executable action/],
      ];
      for (const [decision, message] of cases) {
        it(`decisionToStepRejectsIncomplete: ${decision.action} → ${message.source}`, async () => {
          await expect(decisionToStep(driver, decision)).rejects.toThrow(message);
        });
      }
    });
  }

}
