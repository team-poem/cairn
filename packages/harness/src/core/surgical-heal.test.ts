import { describe, it, expect } from "vitest";
import type { Driver, LlmClient, Reporter } from "./ports.js";
import type { Evidence, PageElement, Scenario, Step, Target } from "./types.js";
import { runScenario } from "../run.js";
import { discover } from "./discover.js";

/** A driver whose URL changes only when a click is configured to navigate — lets a test make a
 * step's `expect` hold, diverge, or be healable. */
class StubDriver implements Driver {
  els: PageElement[] = [];
  readonly navOn: Record<string, string> = {};
  readonly clicked: string[] = [];
  constructor(public url = "https://app/start") {}
  async goto(u: string): Promise<void> {
    this.url = u;
  }
  async click(t: Target): Promise<void> {
    this.clicked.push(t.text ?? "");
    const to = this.navOn[t.text ?? ""];
    if (to) this.url = to;
  }
  async doubleClick(): Promise<void> {}
  async hover(): Promise<void> {}
  async type(): Promise<void> {}
  async select(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async scroll(): Promise<void> {}
  async locate(t: Target): Promise<Target> {
    return t;
  }
  async screenshot(): Promise<string | undefined> {
    return undefined;
  }
  async snapshot(): Promise<PageElement[]> {
    return this.els;
  }
  async settle(): Promise<void> {}
  async observe(): Promise<Evidence> {
    return {
      execution: { actions: [], navigated: true, finalUrl: this.url, blocked: false },
      perception: {},
      logic: { requests: [], console: [] },
    };
  }
  async close(): Promise<void> {}
}

class ScriptedLlm implements LlmClient {
  readonly id = "scripted";
  private i = 0;
  constructor(private readonly replies: string[]) {}
  async complete(): Promise<string> {
    return this.replies[this.i++] ?? '{"action":"done"}';
  }
}

const silent: Reporter = { emit: async () => {} };
// One real assertion — an empty set now fails closed (#69), which would trigger outcome-heal here.
const scn = (steps: Step[]): Scenario => ({ name: "t", steps, assertions: [{ kind: "navigated" }] });

describe("per-step expect verification", () => {
  it("skips a step whose expect already holds (idempotency)", async () => {
    const driver = new StubDriver("https://app/home");
    const s = scn([{ kind: "click", target: { text: "Login" }, expect: { url: "app/home" } }]);
    const { result } = await runScenario(s, { driver, reporter: silent });
    expect(driver.clicked).toEqual([]); // never executed — goal already met
    expect(result.evidence.execution.actions[0]?.ok).toBe(true);
  });

  it("fails a step that ran but whose expect diverges (no healer)", async () => {
    const driver = new StubDriver(); // "Checkout" does not navigate
    const s = scn([{ kind: "click", target: { text: "Checkout" }, expect: { url: "app/payment" } }]);
    const { result } = await runScenario(s, { driver, reporter: silent, expectTimeoutMs: 50 });
    expect(driver.clicked).toEqual(["Checkout"]); // executed
    expect(result.evidence.execution.actions[0]?.ok).toBe(false);
    expect(result.evidence.execution.actions[0]?.error).toContain("post-condition");
  });

  it("surgically heals a diverged step from its intent, then re-freezes it", async () => {
    const driver = new StubDriver();
    driver.els = [{ role: "button", name: "Checkout Now" }];
    driver.navOn["Checkout Now"] = "https://app/payment"; // the right control navigates
    const llm = new ScriptedLlm(['{"action":"click","text":"Checkout Now"}']);
    const s = scn([
      { kind: "click", target: { text: "Checkout" }, intent: "go to payment", expect: { url: "app/payment" } },
    ]);
    const { result, stepHeals, healedScenario } = await runScenario(s, {
      driver,
      llm,
      heal: true,
      reporter: silent,
      expectTimeoutMs: 50,
    });
    expect(result.evidence.execution.actions[0]?.ok).toBe(true); // healed → step passes
    expect(driver.clicked).toEqual(["Checkout", "Checkout Now"]); // original, then corrective
    expect(stepHeals).toHaveLength(1);
    expect(healedScenario?.steps[0]).toMatchObject({
      kind: "click",
      target: { text: "Checkout Now" },
      expect: { url: "app/payment" },
    });
  });

  it("waits for an async post-condition before declaring divergence (readiness poll)", async () => {
    // The click's effect (navigation) lands on a LATER observe, not immediately — an async redirect.
    // A single post-step check would race it; polling the `expect` catches it, with no heal / no LLM.
    class AsyncNav extends StubDriver {
      private observes = 0;
      override async click(t: Target): Promise<void> {
        this.clicked.push(t.text ?? "");
      }
      override async observe(): Promise<Evidence> {
        this.observes += 1;
        const finalUrl = this.observes > 2 ? "https://app/payment" : this.url;
        return {
          execution: { actions: [], navigated: true, finalUrl, blocked: false },
          perception: {},
          logic: { requests: [], console: [] },
        };
      }
    }
    const driver = new AsyncNav();
    const s = scn([{ kind: "click", target: { text: "Checkout" }, expect: { url: "app/payment" } }]);
    const { result } = await runScenario(s, { driver, reporter: silent });
    expect(result.evidence.execution.actions[0]?.ok).toBe(true); // async effect caught by polling
    expect(driver.clicked).toEqual(["Checkout"]); // clicked once, not re-clicked or healed
  });

  it("a requestStatus expect is NOT satisfied by an earlier request (watermark, no pre-skip)", async () => {
    // The matching POST is already in the run's cumulative log (an earlier step / page load fired
    // it). This step's own click sends nothing — it must execute (no idempotency pre-skip) and then
    // diverge, not pass off the stale request.
    class StaleRequestStub extends StubDriver {
      override async observe(): Promise<Evidence> {
        return {
          execution: { actions: [], navigated: false, finalUrl: this.url, blocked: false },
          perception: {},
          logic: { requests: [{ method: "POST", url: "https://api.app/cart", status: 200 }], console: [] },
        };
      }
    }
    const driver = new StaleRequestStub();
    const s = scn([
      {
        kind: "click",
        target: { text: "Add" },
        expect: { requestStatus: { urlIncludes: "api.app/cart", status: 200, method: "POST" } },
      },
    ]);
    const { result } = await runScenario(s, { driver, reporter: silent, expectTimeoutMs: 50 });
    expect(driver.clicked).toEqual(["Add"]); // executed — not skipped as "already satisfied"
    expect(result.evidence.execution.actions[0]?.ok).toBe(false); // stale request doesn't count
  });

  it("a same-path GET does not satisfy a mutation-derived expect (method match)", async () => {
    // After the click, only a GET to the same endpoint+status arrives (a list re-fetch) — the
    // frozen POST expect must not accept it.
    class GetOnlyStub extends StubDriver {
      readonly requests: { method: string; url: string; status: number }[] = [];
      override async click(t: Target): Promise<void> {
        this.clicked.push(t.text ?? "");
        this.requests.push({ method: "GET", url: "https://api.app/orders", status: 200 });
      }
      override async observe(): Promise<Evidence> {
        return {
          execution: { actions: [], navigated: false, finalUrl: this.url, blocked: false },
          perception: {},
          logic: { requests: [...this.requests], console: [] },
        };
      }
    }
    const driver = new GetOnlyStub();
    const s = scn([
      {
        kind: "click",
        target: { text: "Place order" },
        expect: { requestStatus: { urlIncludes: "api.app/orders", status: 200, method: "POST" } },
      },
    ]);
    const { result } = await runScenario(s, { driver, reporter: silent, expectTimeoutMs: 50 });
    expect(result.evidence.execution.actions[0]?.ok).toBe(false);
  });
});

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
