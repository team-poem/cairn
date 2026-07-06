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
      { kind: "no-console-errors" },
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
    expect(scenario.assertions).toEqual([{ kind: "no-failed-requests" }, { kind: "no-console-errors" }]);
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

  it("#79: still freezes no-failed-requests when the only failure recovered (401 → retry → 2xx)", async () => {
    const evRecovered: Evidence = {
      ...evidence,
      logic: {
        requests: [
          { method: "POST", url: "https://shop/api/login", status: 401 },
          { method: "POST", url: "https://shop/api/login", status: 200 },
        ],
        console: [],
      },
    };
    const scenario = await discover("login", {
      driver: new FakeDriver({ evidence: evRecovered, elements: [] }),
      llm: new ScriptedLlm(['{"action":"done"}']),
    });
    // the critic already tolerates recovered failures (#66) — the freeze must not be stricter
    // than the verdict, or a legitimate transient retry costs the flow this assertion.
    expect(scenario.assertions).toContainEqual({ kind: "no-failed-requests" });
  });

  it("#79: does not freeze no-failed-requests when a failure never recovered", async () => {
    const evUnrecovered: Evidence = {
      ...evidence,
      logic: {
        requests: [
          { method: "POST", url: "https://shop/api/login", status: 401 },
          { method: "GET", url: "https://shop/api/login", status: 200 }, // different method — not a recovery
        ],
        console: [],
      },
    };
    const scenario = await discover("login", {
      driver: new FakeDriver({ evidence: evUnrecovered, elements: [] }),
      llm: new ScriptedLlm(['{"action":"done"}']),
    });
    expect(scenario.assertions.some((a) => a.kind === "no-failed-requests")).toBe(false);
  });

  it("#79: a product benign list keeps a marked noisy endpoint from stripping no-failed-requests", async () => {
    const evNoisy: Evidence = {
      ...evidence,
      logic: {
        requests: [{ method: "GET", url: "https://shop/api/flaky-analytics", status: 500 }],
        console: [],
      },
    };
    const scenario = await discover("noop", {
      driver: new FakeDriver({ evidence: evNoisy, elements: [] }),
      llm: new ScriptedLlm(['{"action":"done"}']),
      benign: ["/api/flaky-analytics"],
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
      { kind: "no-console-errors" },
      { kind: "navigated", to: "shop/payment" },
      { kind: "request-status", urlIncludes: "/api/orders", status: 200 },
    ]);
  });

  it("#99: freezes no-console-errors only when the console stayed clean throughout discovery", async () => {
    const clean = await discover("noop", {
      driver: new FakeDriver({ evidence, elements: [] }),
      llm: new ScriptedLlm(['{"action":"done"}']),
    });
    expect(clean.assertions).toContainEqual({ kind: "no-console-errors" });

    const evNoisy: Evidence = {
      ...evidence,
      logic: { requests: [], console: [{ type: "error", text: "TypeError: x is undefined" }] },
    };
    const noisy = await discover("noop", {
      driver: new FakeDriver({ evidence: evNoisy, elements: [] }),
      llm: new ScriptedLlm(['{"action":"done"}']),
    });
    expect(noisy.assertions.some((a) => a.kind === "no-console-errors")).toBe(false);
  });

  it("#99: a proposed no-console-errors cannot override a dirty console (grounding wins)", async () => {
    const evNoisy: Evidence = {
      ...evidence,
      logic: { requests: [], console: [{ type: "error", text: "boom" }] },
    };
    const scenario = await discover("noop", {
      driver: new FakeDriver({ evidence: evNoisy, elements: [] }),
      // the prompt offers no-console-errors with done — grounding must still drop it here
      llm: new ScriptedLlm(['{"action":"done","assertions":[{"kind":"no-console-errors"}]}']),
    });
    expect(scenario.assertions.some((a) => a.kind === "no-console-errors")).toBe(false);
  });

  it("#99: non-error console noise (warnings/logs) does not strip no-console-errors", async () => {
    const evWarn: Evidence = {
      ...evidence,
      logic: { requests: [], console: [{ type: "warning", text: "deprecated API" }] },
    };
    const scenario = await discover("noop", {
      driver: new FakeDriver({ evidence: evWarn, elements: [] }),
      llm: new ScriptedLlm(['{"action":"done"}']),
    });
    expect(scenario.assertions).toContainEqual({ kind: "no-console-errors" });
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
