import { describe, expect, it } from "vitest";
import { discover } from "../../../src/core/discover/index.js";
import type { ActionPolicy, Decision } from "../../../src/core/discover/index.js";
import { FakeDriver } from "../../../src/adapters/drivers/fake.js";
import { ScriptedLlm, StubDriver } from "../../support/doubles.js";
import type { Evidence } from "../../../src/core/types.js";
import type { Target } from "../../../src/core/types.js";

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
    // assertions are grounded in observed evidence — navigated to the real destination, not the
    // LLM's guess. FakeDriver's evidence is static (baseline == final), so every derived check is
    // also stamped vacuous (#137) — an artifact of the double, not of real flows.
    expect(scenario.assertions).toEqual([
      { kind: "no-failed-requests", origin: "derived", vacuous: true },
      { kind: "no-console-errors", origin: "derived", vacuous: true },
      { kind: "navigated", to: "shop/cart", origin: "derived", vacuous: true },
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
    expect(scenario.assertions).toEqual([
      { kind: "no-failed-requests", origin: "derived", vacuous: true },
      { kind: "no-console-errors", origin: "derived", vacuous: true },
    ]);
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
    expect(scenario.assertions).toContainEqual({ kind: "no-failed-requests", origin: "derived", vacuous: true });
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
    expect(scenario.assertions).toContainEqual({ kind: "no-failed-requests", origin: "derived", vacuous: true });
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
    expect(scenario.assertions).toContainEqual({ kind: "no-failed-requests", origin: "derived", vacuous: true });
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
    // #105: the matched proving request is a mutation, so its method is frozen too — a
    // same-prefix GET must not satisfy this check at replay (parity with step-level expects).
    // #172: the frozen URL is the matching request's stable endpoint (host+path), not the
    // proposed substring.
    expect(scenario.assertions).toEqual([
      { kind: "no-failed-requests", origin: "derived", vacuous: true },
      { kind: "no-console-errors", origin: "derived", vacuous: true },
      { kind: "navigated", to: "shop/payment", origin: "derived", vacuous: true },
      { kind: "request-status", urlIncludes: "shop/api/orders", status: 200, method: "POST", origin: "derived", vacuous: true },
    ]);
  });

  it("#105: a grounded request-status matching a non-mutation freezes without a method", async () => {
    const ev: Evidence = {
      ...evidence,
      logic: {
        requests: [{ method: "GET", url: "https://shop/api/cart", status: 200 }],
        console: [],
      },
    };
    const scenario = await discover("view cart", {
      driver: new FakeDriver({ evidence: ev, elements: [] }),
      llm: new ScriptedLlm([
        '{"action":"done"}',
        '[{"kind":"request-status","urlIncludes":"/api/cart","status":200}]',
      ]),
    });
    expect(scenario.assertions).toContainEqual({
      kind: "request-status",
      urlIncludes: "shop/api/cart",
      status: 200,
      origin: "derived",
      vacuous: true,
    });
  });

  it("#99: freezes no-console-errors only when the console stayed clean throughout discovery", async () => {
    const clean = await discover("noop", {
      driver: new FakeDriver({ evidence, elements: [] }),
      llm: new ScriptedLlm(['{"action":"done"}']),
    });
    expect(clean.assertions).toContainEqual({ kind: "no-console-errors", origin: "derived", vacuous: true });

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
    expect(scenario.assertions).toContainEqual({ kind: "no-console-errors", origin: "derived", vacuous: true });
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
    expect(on.assertions).toContainEqual({ kind: "expect", criterion: "order confirmed", origin: "derived" });
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

describe("ambiguity gate (#127) — the loop refuses before the driver", () => {
  const dupes = [
    { role: "link", name: "Log in" },
    { role: "button", name: "Log in" },
    { role: "button", name: "Log in" },
  ];

  it("a duplicated name without nth is a recorded failure; the driver never acts", async () => {
    const driver = new FakeDriver({ evidence, elements: dupes });
    const prompts: string[] = [];
    let i = 0;
    const replies = [
      '{"action":"click","text":"Log in"}', // ambiguous — blocked in core
      '{"action":"click","text":"Log in","role":"button","nth":1}', // re-decided — runs
      '{"action":"done"}',
    ];
    const llm = {
      id: "recording",
      async complete(prompt: string) { prompts.push(prompt); return replies[i++] ?? '{"action":"done"}'; },
    };
    const found = await discover("log in", { driver, llm });
    expect(driver.clicked).toHaveLength(1); // only the disambiguated click executed
    expect(prompts[1]).toContain('elements named "Log in"'); // the failure taught the fix
    expect(prompts[1]).toContain('"nth"');
    expect(found.steps.some((s) => s.kind === "click")).toBe(true);
  });

  it("a wrapper pair (link over its own StaticText) is not ambiguous", async () => {
    const driver = new FakeDriver({
      evidence,
      elements: [
        { role: "link", name: "Learn more" },
        { role: "StaticText", name: "Learn more" },
      ],
    });
    const llm = new ScriptedLlm(['{"action":"click","text":"Learn more"}', '{"action":"done"}']);
    await discover("learn", { driver, llm });
    expect(driver.clicked).toHaveLength(1); // acted without a forced re-decision
  });
});

describe("perception seam (#: perception-gap) — consumer corrects state before the model sees it", () => {
  it("applies perceive() to the snapshot; the LLM listing shows the corrected state", async () => {
    // The a11y tree reports the checkbox unchecked (custom widget), but the consumer knows it's
    // checked and corrects it — the model must see (checked), so it won't re-click it.
    const driver = new FakeDriver({
      evidence,
      elements: [{ role: "checkbox", name: "Select all" }], // no `checked` from a11y
    });
    const prompts: string[] = [];
    let i = 0;
    const replies = ['{"action":"done"}'];
    const llm = {
      id: "recording",
      async complete(prompt: string) { prompts.push(prompt); return replies[i++] ?? '{"action":"done"}'; },
    };
    const perceive = (els: import("../../../src/core/types.js").PageElement[]) =>
      els.map((e) => (e.role === "checkbox" && e.name === "Select all" ? { ...e, checked: true } : e));

    await discover("select all", { driver, llm, perceive });
    expect(prompts[0]).toContain("Select all (checked)"); // corrected state reached the model
  });

  it("without perceive(), the raw snapshot state is used unchanged", async () => {
    const driver = new FakeDriver({ evidence, elements: [{ role: "checkbox", name: "Select all" }] });
    const prompts: string[] = [];
    const llm = {
      id: "recording",
      async complete(prompt: string) { prompts.push(prompt); return '{"action":"done"}'; },
    };
    await discover("select all", { driver, llm });
    expect(prompts[0]).toContain("[checkbox] Select all");
    expect(prompts[0]).not.toContain("(checked)");
  });
});

describe("freeze-time vacuity stamping (#137)", () => {
  it("a do-nothing flow (static evidence) freezes with every assertion flagged", async () => {
    // FakeDriver's observe() never changes → baseline equals final evidence → everything the
    // freeze derives was already true at the start.
    const driver = new FakeDriver({ evidence, elements: [{ role: "link", name: "Go" }] });
    const llm = new ScriptedLlm(['{"action":"click","text":"Go"}', '{"action":"done"}', "[]"]);
    const found = await discover("go somewhere", { driver, llm, baseUrl: "https://example.com" });
    expect(found.assertions.length).toBeGreaterThan(0);
    expect(found.assertions.every((a) => a.vacuous === true)).toBe(true);
  });

  it("a flow that actually navigates freezes a discriminating navigated (no flag)", async () => {
    const driver = new StubDriver("https://app/start");
    driver.els = [{ role: "link", name: "Checkout" }];
    driver.navOn["Checkout"] = "https://app/checkout/done";
    const llm = new ScriptedLlm(['{"action":"click","text":"Checkout"}', '{"action":"done"}', "[]"]);
    const found = await discover("check out", { driver, llm, baseUrl: "https://app/start" });
    const nav = found.assertions.find((a) => a.kind === "navigated");
    expect(nav?.to).toContain("checkout/done");
    expect(nav?.vacuous).toBeUndefined();
  });
});

describe("the product's benign list reaches step expects (spec/core/surgical-heal.md §4)", () => {
  /** A click that fires one successful POST to a product-marked noisy endpoint and never navigates. */
  class BeaconStub extends StubDriver {
    private fired = false;

    override async click(target: Target): Promise<void> {
      this.clicked.push(target.text ?? "");
      if (target.text === "Track") this.fired = true;
    }

    override async observe(): Promise<Evidence> {
      const requests = this.fired
        ? [{ method: "POST", url: "https://analytics.x/track/events", status: 200 }]
        : [];
      return {
        execution: { actions: [], navigated: false, finalUrl: this.url, blocked: false },
        perception: {},
        logic: { requests, console: [] },
      };
    }
  }

  it("benignListReachesStepExpects: a product-marked endpoint is not frozen as a step expect", async () => {
    const driver = new BeaconStub();
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Track","reason":"go"}',
      '{"action":"done"}',
    ]);
    const found = await discover("browse", { driver, llm, benign: ["analytics.x"] });
    expect(found.steps[0]?.expect).toBeUndefined();
  });

  it("benignListReachesStepExpects: without the list the same beacon still freezes (control)", async () => {
    const driver = new BeaconStub();
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Track","reason":"go"}',
      '{"action":"done"}',
    ]);
    const found = await discover("browse", { driver, llm });
    expect(found.steps[0]?.expect).toEqual({
      requestStatus: { urlIncludes: "analytics.x/track/events", status: 200, method: "POST" },
    });
  });
});
