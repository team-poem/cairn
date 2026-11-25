import { describe, expect, it, vi } from "vitest";
import { discover, explore, SelfHealingDriver } from "../src/index.js";
import { stepError } from "../src/core/errors.js";
import type { Target } from "../src/core/types.js";
import { ScriptedLlm, StubDriver } from "./support/doubles.js";

const save = { action: "click", role: "button", text: "Save" };
const done = { action: "done" };
function scripted(...decisions: object[]) {
  return new ScriptedLlm([...decisions.map(d => JSON.stringify(d)), "[]"]);
}

// The adapter resolves targets inside its action method; only an actual browser input
// notifies the listener. Opening a list and then failing to find an option is a partial send.
class MeasuredInputs extends StubDriver {
  beforeSend?: () => void;
  readonly input: string[] = [];
  readonly lookups: string[] = [];
  armActionOutcomeDispatch(check: () => void) { this.beforeSend = check; }
  clearActionOutcomeDispatch() { this.beforeSend = undefined; }
  override async type(t?: Target) {
    this.lookups.push(t?.text ?? "");
    if (t?.text !== "Email") throw stepError("resolution", "textbox not found");
    this.beforeSend?.();
    this.input.push("fill");
  }
  override async select() {
    this.beforeSend?.();
    this.input.push("open list");
    throw stepError("resolution", "option not found");
  }
}

describe.each([["discover", discover], ["explore", explore]] as const)("%s with a self-healing driver", (_mode, run) => {
  it("never retries an unacknowledged input, even when a legacy driver labels the error as resolution", async () => {
    class LostReply extends StubDriver {
      override async click(t: Target) {
        await super.click(t);
        if (this.clicked.length === 1) throw stepError("resolution", "node detached after click");
      }
    }
    const inner = new LostReply();
    inner.els = [{ role: "button", name: "Save" }];
    const healer = scripted({ name: "Save" }), repair = vi.spyOn(healer, "complete");
    const driver = new SelfHealingDriver(inner, healer);
    const result = await run("Save once", { driver, baseUrl: inner.url, llm: scripted(save, done),
      budget: { maxModelCalls: 8 }, actionOutcomes: {} });
    expect(result.truncationReason).toBe("click-dispatch-uncertain");
    expect(result.steps.filter(s => s.kind === "click")).toHaveLength(0);
    expect(inner.clicked).toEqual(["Save"]);
    expect(repair).not.toHaveBeenCalled();
  });

  it("lets the model choose again after lookup fails before a fill", async () => {
    const inner = new MeasuredInputs();
    inner.els = [{ role: "textbox", name: "Email" }];
    const healer = scripted({ name: "Email" }), repair = vi.spyOn(healer, "complete");
    const type = { action: "type", role: "textbox", value: "test" };
    const result = await run("Enter a value", { driver: new SelfHealingDriver(inner, healer),
      baseUrl: inner.url, llm: scripted({ ...type, text: "Missing" }, { ...type, text: "Email" }, done),
      budget: { maxModelCalls: 8 }, actionOutcomes: {} });
    expect(result.truncated).not.toBe(true);
    expect(inner.lookups).toEqual(["Missing", "Email"]);
    expect(inner.input).toEqual(["fill"]);
    expect(result.steps.filter(s => s.kind === "type")).toMatchObject([{ target: { text: "Email" } }]);
    expect(repair).not.toHaveBeenCalled();
    expect(inner.beforeSend).toBeUndefined();
  });

  it("does not repair a missing option after the first select input was sent", async () => {
    const inner = new MeasuredInputs();
    inner.els = [{ role: "combobox", name: "Color" }];
    const healer = scripted({ name: "Color" }), repair = vi.spyOn(healer, "complete");
    const result = await run("Choose color", { driver: new SelfHealingDriver(inner, healer), baseUrl: inner.url,
      llm: scripted({ action: "select", text: "Color", value: "Blue" }, done), actionOutcomes: {} });
    expect(inner.input).toEqual(["open list"]);
    expect(repair).not.toHaveBeenCalled();
    expect(result.truncationReason).toBe("action-dispatch-uncertain");
    expect(result.steps.filter(s => s.kind === "select")).toHaveLength(0);
    expect(inner.beforeSend).toBeUndefined();
  });

  it("preserves the inner click receipt and veto", async () => {
    class WithIdentity extends StubDriver {
      beforeClick?: (id: string | undefined) => void;
      armActionOutcomeIdentity(check?: (id: string | undefined) => void) { this.beforeClick = check; }
      takeActionOutcomeIdentity() { this.beforeClick = undefined; return "node-1"; }
      override async click(t: Target) {
        this.beforeClick?.("node-1");
        await super.click(t);
      }
    }
    const inner = new WithIdentity();
    inner.els = [{ role: "button", name: "Save" }];
    const driver = new SelfHealingDriver(inner, scripted({ name: "Save" }));
    const result = await run("Click Save", { driver, baseUrl: inner.url,
      llm: scripted(save, save, done), actionOutcomes: { maxRepeats: 1 } });
    expect(result.truncationReason).toBe("action-no-progress");
    expect(inner.clicked).toEqual(["Save"]);
    expect(driver.heals).toHaveLength(0);
    expect(inner.beforeClick).toBeUndefined();
  });
});
