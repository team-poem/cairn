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
const scn = (steps: Step[]): Scenario => ({ name: "t", steps, assertions: [] });

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
    const { result } = await runScenario(s, { driver, reporter: silent });
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
