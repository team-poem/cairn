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
