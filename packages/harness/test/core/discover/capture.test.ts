import { describe, expect, it } from "vitest";
import { discover } from "../../../src/core/discover/index.js";
import { ScriptedLlm, StubDriver } from "../../support/doubles.js";
import type { Evidence, Target } from "../../../src/core/types.js";

describe("discover captures intent + expect", () => {
  it("stores the action reason as intent and a navigation as expect", async () => {
    const driver = new StubDriver();
    driver.navOn["Select"] = "https://app/cart";
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Select","reason":"select the item"}',
      '{"action":"done"}',
    ]);
    const found = await discover("buy", { driver, llm });
    expect(found.steps[0]?.intent).toBe("select the item");
    expect(found.steps[0]?.expect).toEqual({ url: "app/cart" });
  });

  it("captures a fresh successful mutation as a requestStatus expect (async action, no nav)", async () => {
    // A submit that fires a POST but doesn't navigate — the URL-only check missed it; now it's frozen
    // as a requestStatus expect so replay can wait for that request.
    class MutationStub extends StubDriver {
      private submitted = false;
      override async click(t: Target): Promise<void> {
        this.clicked.push(t.text ?? "");
        if (t.text === "Submit") this.submitted = true;
      }
      override async observe(): Promise<Evidence> {
        const requests = this.submitted
          ? [{ method: "POST", url: "https://api.app/v1/orders?x=1", status: 200 }]
          : [];
        return {
          execution: { actions: [], navigated: false, finalUrl: this.url, blocked: false },
          perception: {},
          logic: { requests, console: [] },
        };
      }
    }
    const driver = new MutationStub();
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Submit","reason":"place order"}',
      '{"action":"done"}',
    ]);
    const found = await discover("place an order", { driver, llm });
    expect(found.steps[0]?.expect).toEqual({
      requestStatus: { urlIncludes: "api.app/v1/orders", status: 200, method: "POST" },
    });
  });

  it("freezes a stable path prefix, not a run-specific id segment", async () => {
    class IdMutationStub extends StubDriver {
      private submitted = false;
      override async click(t: Target): Promise<void> {
        this.clicked.push(t.text ?? "");
        if (t.text === "Confirm") this.submitted = true;
      }
      override async observe(): Promise<Evidence> {
        const requests = this.submitted
          ? [{ method: "POST", url: "https://api.app/orders/ord_8f3a2c/confirm", status: 200 }]
          : [];
        return {
          execution: { actions: [], navigated: false, finalUrl: this.url, blocked: false },
          perception: {},
          logic: { requests, console: [] },
        };
      }
    }
    const driver = new IdMutationStub();
    const llm = new ScriptedLlm(['{"action":"click","text":"Confirm"}', '{"action":"done"}']);
    const found = await discover("confirm order", { driver, llm });
    // "ord_8f3a2c" is a fresh id every run — freezing it would never match a later replay.
    expect(found.steps[0]?.expect).toEqual({
      requestStatus: { urlIncludes: "api.app/orders", status: 200, method: "POST" },
    });
  });

  it("a repeated identical mutation still gets an expect (append-only tail, not a seen-set)", async () => {
    class RepeatStub extends StubDriver {
      readonly requests: { method: string; url: string; status: number }[] = [];
      override async click(t: Target): Promise<void> {
        this.clicked.push(t.text ?? "");
        if (t.text === "Add") this.requests.push({ method: "POST", url: "https://api.app/cart", status: 200 });
      }
      override async observe(): Promise<Evidence> {
        return {
          execution: { actions: [], navigated: false, finalUrl: this.url, blocked: false },
          perception: {},
          logic: { requests: [...this.requests], console: [] },
        };
      }
    }
    const driver = new RepeatStub();
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Add"}',
      '{"action":"click","text":"Add"}',
      '{"action":"done"}',
    ]);
    const found = await discover("add two items", { driver, llm });
    // The second POST is identical to the first — it must still freeze this step's post-condition.
    expect(found.steps[1]?.expect).toEqual({
      requestStatus: { urlIncludes: "api.app/cart", status: 200, method: "POST" },
    });
  });

  it("can produce a waitFor step (P4 — discover synchronizes, not just replay)", async () => {
    const driver = new StubDriver("https://app/dashboard"); // the awaited condition already holds
    const llm = new ScriptedLlm([
      '{"action":"waitFor","until":{"url":"dashboard"},"reason":"auth redirect lands"}',
      '{"action":"done"}',
    ]);
    const found = await discover("wait then done", { driver, llm });
    expect(found.steps[0]).toMatchObject({ kind: "waitFor", until: { url: "dashboard" } });
  });
});
