import { describe, expect, it } from "vitest";
import { discover } from "../../../src/core/discover/index.js";
import type { ActionPolicy, Decision } from "../../../src/core/discover/index.js";
import { FakeDriver } from "../../../src/adapters/drivers/fake.js";
import { ScriptedLlm } from "../../support/doubles.js";
import type { Evidence } from "../../../src/core/types.js";

const evidence: Evidence = {
  execution: { actions: [], navigated: true, finalUrl: "https://shop/cart", blocked: false },
  perception: {},
  logic: { requests: [], console: [] },
};

describe("discover", () => {
  it("turns an intent into a Scenario via observe→act→adapt", async () => {
    const driver = new FakeDriver({
      evidence,
      elements: [
        { role: "link", name: "Add to cart" },
        { role: "button", name: "Checkout" },
      ],
    });
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Add to cart","reason":"add item"}',
      '{"action":"click","text":"Checkout","reason":"proceed"}',
      '{"action":"done","assertions":[{"kind":"navigated"},{"kind":"no-failed-requests"}]}',
    ]);

    const scenario = await discover("checkout flow", { driver, llm, baseUrl: "https://shop" });

    // targets are enriched with resilient locators (role + structural index) at freeze time;
    // the decision's reason is captured as `intent` for surgical-heal (no URL change here → no expect)
    expect(scenario.steps).toEqual([
      { kind: "goto", url: "https://shop" },
      { kind: "click", target: { text: "Add to cart", role: "link", index: 0 }, intent: "add item" },
      { kind: "click", target: { text: "Checkout", role: "button", index: 0 }, intent: "proceed" },
    ]);
    // assertions are grounded in observed evidence — navigated to the real destination, not the LLM's guess
    expect(scenario.assertions).toEqual([
      { kind: "no-failed-requests" },
      { kind: "navigated", to: "shop/cart" },
    ]);
    expect(driver.clicked).toHaveLength(2);
  });

  it("recovers from a failed action and adapts instead of crashing", async () => {
    // First pick a target that doesn't resolve; discover should not throw, but try again.
    const driver = new FakeDriver({
      evidence,
      elements: [{ role: "link", name: "Open" }],
      failOn: ["Gone"],
    });
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Gone"}',
      '{"action":"click","text":"Open"}',
      '{"action":"done"}',
    ]);

    const scenario = await discover("adapt", { driver, llm });

    // The failed click is not recorded; only the successful one is.
    expect(scenario.steps).toEqual([{ kind: "click", target: { text: "Open", role: "link", index: 0 } }]);
    expect(driver.clicked).toEqual([{ text: "Open", role: "link", index: 0 }]);
  });

  it("flags a scenario truncated at the step cap (P10)", async () => {
    const driver = new FakeDriver({ evidence, elements: [{ role: "button", name: "Next" }] });
    const llm = new ScriptedLlm(Array(5).fill('{"action":"click","text":"Next"}')); // never says done
    const scenario = await discover("loops", { driver, llm, maxSteps: 3 });
    expect(scenario.truncated).toBe(true);
    expect(scenario.steps).toHaveLength(3);
  });

  it("grounds assertions in evidence — no `navigated` on a flow that didn't navigate (SPA)", async () => {
    const spaEvidence: Evidence = {
      ...evidence,
      execution: { ...evidence.execution, navigated: false },
    };
    const driver = new FakeDriver({ evidence: spaEvidence, elements: [] });
    // LLM wrongly proposes `navigated`; grounding must drop it.
    const llm = new ScriptedLlm(['{"action":"done","assertions":[{"kind":"navigated"}]}']);
    const scenario = await discover("noop", { driver, llm });
    expect(scenario.assertions).toEqual([{ kind: "no-failed-requests" }]);
  });

  it("does not freeze no-failed-requests when discovery itself saw a real failure (grounding)", async () => {
    const evFail: Evidence = {
      ...evidence,
      logic: { requests: [{ method: "GET", url: "https://shop/api/me", status: 404 }], console: [] },
    };
    const driver = new FakeDriver({ evidence: evFail, elements: [] });
    const scenario = await discover("noop", { driver, llm: new ScriptedLlm(['{"action":"done"}']) });
    // it didn't hold during discovery → freezing it would fail every replay on an already-false check
    expect(scenario.assertions.some((a) => a.kind === "no-failed-requests")).toBe(false);
  });

  it("still freezes no-failed-requests when only a benign request failed (favicon)", async () => {
    const evFavicon: Evidence = {
      ...evidence,
      logic: { requests: [{ method: "GET", url: "https://shop/favicon.ico", status: 404 }], console: [] },
    };
    const scenario = await discover("noop", {
      driver: new FakeDriver({ evidence: evFavicon, elements: [] }),
      llm: new ScriptedLlm(['{"action":"done"}']),
    });
    expect(scenario.assertions).toContainEqual({ kind: "no-failed-requests" });
  });

  it("#16: freezes a proposed request-status only when a real request matches it", async () => {
    const ev: Evidence = {
      execution: { actions: [], navigated: true, finalUrl: "https://shop/payment", blocked: false },
      perception: {},
      logic: {
        requests: [{ method: "POST", url: "https://shop/api/orders", status: 200 }],
        console: [],
      },
    };
    const driver = new FakeDriver({ evidence: ev, elements: [{ role: "button", name: "Pay" }] });
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Pay"}',
      '{"action":"done"}',
      // proposeAssertions reply: one grounded (matches a request), one hallucinated (no match)
      '[{"kind":"request-status","urlIncludes":"/api/orders","status":200},{"kind":"request-status","urlIncludes":"/api/ghost","status":200}]',
    ]);
    const scenario = await discover("pay", { driver, llm });
    expect(scenario.assertions).toEqual([
      { kind: "no-failed-requests" },
      { kind: "navigated", to: "shop/payment" },
      { kind: "request-status", urlIncludes: "/api/orders", status: 200 },
    ]);
  });

  it("#16: freezes `expect` only when semanticChecks is on (invariant #4)", async () => {
    const replies = ['{"action":"done"}', '[{"kind":"expect","criterion":"order confirmed"}]'];
    const off = await discover("x", {
      driver: new FakeDriver({ evidence, elements: [] }),
      llm: new ScriptedLlm([...replies]),
    });
    expect(off.assertions.some((a) => a.kind === "expect")).toBe(false);

    const on = await discover("x", {
      driver: new FakeDriver({ evidence, elements: [] }),
      llm: new ScriptedLlm([...replies]),
      semanticChecks: true,
    });
    expect(on.assertions).toContainEqual({ kind: "expect", criterion: "order confirmed" });
  });
});

describe("discover action policy (#65)", () => {
  it("blocks a policy-rejected action — it never runs; the LLM re-decides", async () => {
    const driver = new FakeDriver({
      evidence,
      elements: [
        { role: "button", name: "Delete" },
        { role: "link", name: "Add to cart" },
      ],
    });
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Delete","reason":"remove"}', // blocked
      '{"action":"click","text":"Add to cart","reason":"add"}', // re-decided, allowed
      '{"action":"done"}',
    ]);
    const policy: ActionPolicy = {
      vet: (d: Decision) =>
        d.text === "Delete" ? { ok: false, reason: "destructive" } : { ok: true },
    };
    const found = await discover("buy", { driver, llm, policy });
    expect(driver.clicked.some((t) => t.text === "Delete")).toBe(false); // never executed
    expect(driver.clicked.some((t) => t.text === "Add to cart")).toBe(true);
    expect(found.steps.every((s) => !("target" in s && s.target.text === "Delete"))).toBe(true);
  });

  it("ends discovery when the policy says stop (not a truncation)", async () => {
    const driver = new FakeDriver({ evidence, elements: [{ role: "link", name: "Add to cart" }] });
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Add to cart","reason":"add"}',
      '{"action":"click","text":"Add to cart"}', // would keep going, but policy stops first
    ]);
    const policy: ActionPolicy = { vet: () => ({ ok: true }), stop: (steps) => steps.length >= 1 };
    const found = await discover("buy", { driver, llm, policy });
    expect(found.steps).toHaveLength(1); // stopped after the first step
    expect(found.truncated).toBeUndefined(); // intentional stop, not a step-cap truncation
  });
});

describe("action policy observation context (#77)", () => {
  const elements = [{ role: "button", name: "Confirm" }];

  it("vet sees the page — elements and current url", async () => {
    const driver = new FakeDriver({ evidence, elements });
    const llm = new ScriptedLlm(['{"action":"click","text":"Confirm"}', '{"action":"done"}']);
    const seen: unknown[] = [];
    const policy: ActionPolicy = {
      vet: (_d, ctx) => {
        seen.push(ctx);
        return { ok: true };
      },
    };
    await discover("confirm", { driver, llm, policy });
    expect(seen[0]).toMatchObject({ elements, url: evidence.execution.finalUrl });
  });

  it("stop sees the fresh page elements — a goal is a page property", async () => {
    const driver = new FakeDriver({ evidence, elements });
    const llm = new ScriptedLlm(['{"action":"done"}']);
    let ctxElements: unknown;
    const policy: ActionPolicy = {
      vet: () => ({ ok: true }),
      stop: (_steps, ctx) => {
        ctxElements = ctx?.elements;
        return false;
      },
    };
    await discover("confirm", { driver, llm, policy });
    expect(ctxElements).toEqual(elements);
  });

  it("a throwing vet is a recorded rejection, not a lost discovery", async () => {
    const driver = new FakeDriver({ evidence, elements });
    const llm = new ScriptedLlm([
      '{"action":"scroll"}', // no text → a naive policy reading decision.text.toLowerCase() throws
      '{"action":"click","text":"Confirm"}',
      '{"action":"done"}',
    ]);
    const policy: ActionPolicy = {
      vet: (d) => (d.text!.toLowerCase() === "delete" ? { ok: false, reason: "x" } : { ok: true }),
    };
    const found = await discover("confirm", { driver, llm, policy });
    expect(found.steps.some((s) => s.kind === "click")).toBe(true); // survived the throw
  });

  it("gives up after 3 consecutive blocks instead of burning LLM calls to the cap", async () => {
    const driver = new FakeDriver({ evidence, elements });
    let llmCalls = 0;
    const llm = {
      id: "scripted",
      async complete() {
        llmCalls++;
        return '{"action":"click","text":"Confirm"}';
      },
    };
    const policy: ActionPolicy = { vet: () => ({ ok: false, reason: "blocked" }) };
    const found = await discover("confirm", { driver, llm, policy });
    expect(found.truncated).toBe(true); // blocked out — not a trusted path
    expect(llmCalls).toBeLessThanOrEqual(4); // 3 decisions + at most the assertion proposal
  });

  it("a goal reached on the final iteration is a trusted finish, not a truncation", async () => {
    const driver = new FakeDriver({ evidence, elements });
    const llm = new ScriptedLlm(['{"action":"click","text":"Confirm"}', "[]"]);
    const policy: ActionPolicy = {
      vet: () => ({ ok: true }),
      stop: (steps) => steps.length >= 1,
    };
    const found = await discover("confirm", { driver, llm, policy, maxSteps: 1 });
    expect(found.steps).toHaveLength(1);
    expect(found.truncated).toBeUndefined(); // cap hit, but the stop re-check trusted it
  });
});

describe("current page url in the prompt (#116)", () => {
  it("first turn shows the baseUrl; later turns show the observed url", async () => {
    const driver = new FakeDriver({ evidence, elements: [{ role: "link", name: "Go" }] });
    const prompts: string[] = [];
    let i = 0;
    const replies = ['{"action":"click","text":"Go"}', '{"action":"done"}'];
    const llm = {
      id: "recording",
      async complete(prompt: string) {
        prompts.push(prompt);
        return replies[i++] ?? '{"action":"done"}';
      },
    };
    await discover("go", { driver, llm, baseUrl: "https://example.com" });
    expect(prompts[0]).toContain("Current page: https://example.com");
    expect(prompts[1]).toContain(`Current page: ${evidence.execution.finalUrl}`);
  });
});
