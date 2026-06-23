import { describe, expect, it } from "vitest";
import { BuiltinStepHandler, CustomStepHandler, defaultStepHandlers } from "./steps.js";
import { FakeDriver } from "../adapters/drivers/fake.js";
import type { Evidence, Step } from "./types.js";

const EVIDENCE: Evidence = {
  execution: { actions: [], navigated: false, blocked: false },
  perception: {},
  logic: { requests: [], console: [] },
};

const driver = () => new FakeDriver({ evidence: EVIDENCE });

describe("BuiltinStepHandler", () => {
  const handler = new BuiltinStepHandler();

  it("supports every built-in kind but not custom", () => {
    expect(handler.supports({ kind: "click", target: { text: "A" } })).toBe(true);
    expect(handler.supports({ kind: "scroll" })).toBe(true);
    expect(handler.supports({ kind: "custom", name: "x" })).toBe(false);
  });

  it("routes a step to the matching driver method", async () => {
    const d = driver();
    await handler.execute({ kind: "hover", target: { text: "Menu" } }, d);
    await handler.execute({ kind: "pressKey", key: "Enter" }, d);
    expect(d.hovered).toEqual([{ text: "Menu" }]);
    expect(d.keys).toEqual(["Enter"]);
  });

  it("rejects a custom step it should never have been routed (ordering guard)", async () => {
    await expect(handler.execute({ kind: "custom", name: "wiggle" }, driver())).rejects.toThrow(/custom step/);
  });
});

describe("CustomStepHandler", () => {
  it("supports only custom steps", () => {
    const handler = new CustomStepHandler({});
    expect(handler.supports({ kind: "custom", name: "x" })).toBe(true);
    expect(handler.supports({ kind: "click", target: {} })).toBe(false);
  });

  it("invokes the registered action with its params", async () => {
    const seen: unknown[] = [];
    const handler = new CustomStepHandler({ wiggle: async (_d, p) => void seen.push(p.n) });
    await handler.execute({ kind: "custom", name: "wiggle", params: { n: 3 } }, driver());
    expect(seen).toEqual([3]);
  });

  it("throws when no action is registered for the name", async () => {
    const handler = new CustomStepHandler({});
    await expect(handler.execute({ kind: "custom", name: "missing" }, driver())).rejects.toThrow(/no handler registered/);
  });
});

describe("defaultStepHandlers", () => {
  it("routes built-ins and custom through one find(supports) chain", async () => {
    const seen: string[] = [];
    const handlers = defaultStepHandlers({ ping: async () => void seen.push("ping") });
    const d = driver();
    const run = async (step: Step) => {
      const h = handlers.find((x) => x.supports(step));
      if (!h) throw new Error(`no handler for ${step.kind}`);
      await h.execute(step, d);
    };
    await run({ kind: "click", target: { text: "Go" } });
    await run({ kind: "custom", name: "ping" });
    expect(d.clicked).toEqual([{ text: "Go" }]);
    expect(seen).toEqual(["ping"]);
  });
});
