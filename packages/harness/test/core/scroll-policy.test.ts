import { describe, expect, it, vi } from "vitest";
import { createScrollNoProgressPolicy } from "../../src/core/scroll-policy.js";
import { composePolicies, policyContext, scrollStateKey } from "../../src/core/action-policy.js";
import { discover } from "../../src/core/discover/index.js";
import { explore } from "../../src/core/explore/index.js";
import type { ActionPolicy, PolicyContext } from "../../src/core/discover/decision.js";
import type { PageElement, ScrollState } from "../../src/core/types.js";
import { startTrace, type TraceEvent } from "../../src/core/trace.js";
import { ScriptedLlm, StubDriver } from "../support/doubles.js";

const geometry: ScrollState = { region: "document-one", x: 0, y: 0, width: 800, height: 600, scrollWidth: 800, scrollHeight: 3000 };
const rows: PageElement[] = [{ role: "button", name: "Continue" }, { role: "checkbox", name: "Choice", checked: false }];
const context = (y = 0, elements = rows): PolicyContext => ({ elements, url: "https://app/start", scroll: { ...geometry, y } });
function session(options = {}) { return createScrollNoProgressPolicy({ tolerance: 2, ...options }).createRun!(); }
function scroll(policy: ActionPolicy, ctx = context(), direction: "up" | "down" = "down") {
  expect(policy.vet({ action: "scroll", direction }, ctx).ok).toBe(true);
  policy.executed!({ kind: "scroll", direction }, ctx);
  policy.observe!(ctx);
}

describe("opt-in scroll no-progress policy", () => {
  it("detects successful repeated transitions, not proposals or vet calls", () => {
    const p = session(); p.observe!(context());
    for (let i = 0; i < 20; i++) { p.vet({ action: "scroll" }); p.observe!(context()); }
    expect(p.incomplete!()).toBeUndefined();
    scroll(p); scroll(p);
    expect(p.vet({ action: "scroll" })).toMatchObject({ ok: false, diagnostic: { code: "no-progress", repeatedTransitions: 2 } });
    expect(p.vet({ action: "click", text: "Continue" }).ok).toBe(true);
  });

  it("allows new positions with identical offscreen content, then detects a down/up cycle", () => {
    const p = session(); p.observe!(context());
    for (const y of [400, 800, 1200]) scroll(p, context(y));
    expect(p.incomplete!()).toBeUndefined();
    scroll(p, context(800), "up"); scroll(p, context(1200));
    expect(p.incomplete!()?.diagnostic.code).toBe("no-progress");
  });

  it("ignores ordering, refs and clickable-region churn while preserving multiplicity", () => {
    const p = session(); p.observe!(context());
    const churn = rows.map((e, i) => ({ ...e, ref: `rotating-${i}`, clickableRegion: `region-${i}` })).reverse();
    scroll(p, context(0, churn)); scroll(p, context(0, churn.reverse()));
    expect(p.incomplete!()).toBeDefined();
    p.observe!(context(0, [...rows, rows[0]!]));
    expect(p.incomplete!()).toBeUndefined();
  });

  it.each([
    ["content", context(0, [{ role: "button", name: "New page item" }])],
    ["value", context(0, rows.map(e => ({ ...e, value: "new" })))],
    ["checked", context(0, rows.map(e => ({ ...e, checked: true })))],
    ["disabled", context(0, rows.map(e => ({ ...e, disabled: true })))],
    ["lazy extent", { ...context(), scroll: { ...geometry, scrollHeight: 4000 } }],
    ["region", { ...context(), scroll: { ...geometry, region: "another-region" } }],
    ["navigation", { ...context(), url: "https://app/done" }],
  ])("recovers on new %s evidence (including recycled nodes)", (_, changed) => {
    const p = session(); p.observe!(context()); scroll(p); scroll(p);
    p.observe!(changed as PolicyContext);
    expect(p.incomplete!()).toBeUndefined();
    expect(p.vet({ action: "scroll" }).ok).toBe(true);
  });

  it("abstains on missing, invalid, oversized or interrupted coverage", () => {
    for (const ctx of [
      { ...context(), scroll: undefined }, { ...context(), url: undefined },
      { ...context(), scroll: { ...geometry, y: NaN } },
      context(0, [{ role: "text", name: "x".repeat(33000) }]),
    ]) {
      const p = session(); p.observe!(context()); scroll(p); scroll(p);
      p.observe!(ctx);
      expect(p.incomplete!()).toBeUndefined();
      for (let i = 0; i < 5; i++) scroll(p, ctx);
      expect(p.incomplete!()).toBeUndefined();
    }
  });

  it("cannot reset the recovery bound with waits, notes, or harmless alternation", () => {
    const p = session({ recoveryTurns: 2 }); p.observe!(context()); scroll(p); scroll(p);
    p.executed!({ kind: "pressKey", key: "Shift" }, context()); p.observe!(context());
    expect(p.incomplete!()?.halt).toBe(false);
    p.vet({ action: "note", text: "Still here" }); p.observe!(context());
    expect(p.incomplete!()?.halt).toBe(true);
    const diagnostic = JSON.stringify(p.incomplete!());
    expect(diagnostic).not.toMatch(/Continue|Choice|https|document-one|fingerprint/);
  });

  it("bounds history and validates configuration without silently truncating evidence", () => {
    const p = session({ historySize: 2 });
    p.observe!(context()); scroll(p, context(100)); scroll(p, context(200)); scroll(p, context());
    expect(p.incomplete!()).toBeUndefined(); // evicted state is unknown, not a cycle
    for (const options of [{ tolerance: 0 }, { historySize: 1 }, { recoveryTurns: Infinity }, { maxStateChars: 1 }]) {
      expect(() => session(options)).toThrow();
    }
    expect(scrollStateKey({ ...geometry, y: 999999 })).toBeUndefined();
    expect(policyContext(rows, "https://app", geometry, { ...geometry, y: 1 }).scroll).toBeUndefined();
  });

  it("isolates reused configurations and composed run factories", () => {
    const config = composePolicies(createScrollNoProgressPolicy({ tolerance: 1 }), { vet: () => ({ ok: true }) });
    const first = config.createRun!(), second = config.createRun!();
    first.observe!(context()); second.observe!(context()); scroll(first);
    expect(first.incomplete!()).toBeDefined(); expect(second.incomplete!()).toBeUndefined();
    expect(config.createRun!().incomplete!()).toBeUndefined();
  });

  it.each(["occluded", "clickable"] as const)("recovers when measured %s reveals an actionable target", field => {
    const p = session({ tolerance: 1, recoveryTurns: 1 });
    const hidden = context(0, [{ role: "button", name: "Continue", [field]: field === "occluded" }]);
    p.observe!(hidden); scroll(p, hidden);
    expect(p.incomplete!()).toBeDefined();
    p.observe!(context(0, [{ role: "button", name: "Continue", [field]: field !== "occluded" }]));
    expect(p.incomplete!()).toBeUndefined();
  });

  it("allows an untried opposite direction at the bottom and recovers on a new position", () => {
    const p = session(); const bottom = context(2400);
    p.observe!(bottom); scroll(p, bottom); scroll(p, bottom);
    expect(p.vet({ action: "scroll", direction: "down" }).ok).toBe(false);
    expect(p.vet({ action: "scroll", direction: "up" }).ok).toBe(true);
    scroll(p, context(1800), "up");
    expect(p.incomplete!()).toBeUndefined();
  });

  it("bounds an unproductive opposite-direction recovery and still blocks known down/up cycles", () => {
    const p = session({ recoveryTurns: 1 }); p.observe!(context()); scroll(p); scroll(p);
    scroll(p, context(), "up");
    expect(p.incomplete!()?.halt).toBe(true);
    expect(p.vet({ action: "scroll", direction: "up" }).ok).toBe(false);
    const cycle = session(); cycle.observe!(context());
    scroll(cycle, context(500)); scroll(cycle, context(), "up"); scroll(cycle, context(500));
    expect(cycle.vet({ action: "scroll", direction: "up" }).ok).toBe(false);
  });

  it("does not accumulate evidence while moving through new virtualized semantics at one position", () => {
    const p = session(); p.observe!(context());
    for (let i = 0; i < 80; i++) {
      scroll(p, context(0, [{ role: "listitem", name: `Item ${i}`, ref: "recycled-node" }]));
      expect(p.incomplete!()).toBeUndefined();
    }
  });
});

class ScrollDriver extends StubDriver {
  y = 0;
  executed = 0;
  failScroll = false;
  supported = true;
  constructor() { super(); this.els = rows.map(e => ({ ...e })); }
  async scrollState() { return this.supported ? { ...geometry, y: this.y } : undefined; }
  override async scroll() {
    if (this.failScroll) throw new Error("dispatch failed");
    this.executed++;
  }
}
const down = '{"action":"scroll","direction":"down"}';
const done = '{"action":"done"}';
async function run(mode: "discover" | "explore", driver: ScrollDriver, policy: ActionPolicy | undefined,
  replies: string[], maxSteps = 20) {
  const events: TraceEvent[] = [];
  const trace = startTrace({ emit: event => events.push(event) }, "test").scope("scroll-test");
  const llm = new ScriptedLlm(replies);
  const complete = vi.spyOn(llm, "complete");
  const opts = { driver, llm, policy, maxSteps, baseUrl: driver.url, trace };
  const result = mode === "discover" ? await discover("Reach the goal", opts) : await explore("Reach the goal", opts);
  return { result, events, calls: complete.mock.calls.length };
}

describe.each(["discover", "explore"] as const)("%s lifecycle", mode => {
  it("does not let done bypass active no-progress; preserves stable truncation reason", async () => {
    const driver = new ScrollDriver();
    const { result, events } = await run(mode, driver, createScrollNoProgressPolicy({ tolerance: 2 }), [down, down, done]);
    expect(driver.executed).toBe(2);
    expect(result).toMatchObject({ truncated: true, truncationReason: "no-progress" });
    expect(events.some(e => e.kind === "gate" && e.payload.gate === "no-progress")).toBe(true);
    if ("findings" in result) expect(result.findings.some(f => f.detail.includes("Repeated executed scrolls"))).toBe(false);
  });

  it("emits a structured rejection and terminates bounded recovery even with alternate actions", async () => {
    const driver = new ScrollDriver();
    const { result, events } = await run(mode, driver, createScrollNoProgressPolicy({ tolerance: 1, recoveryTurns: 2 }),
      [down, down, '{"action":"pressKey","key":"Shift"}', down, done]);
    expect(result.truncationReason).toBe("no-progress");
    expect(driver.executed).toBe(1);
    expect(events.some(e => e.kind === "gate" && e.payload.gate === "policy" && e.payload.code === "no-progress")).toBe(true);
  });

  it.each(["rejected", "failed"])("does not count %s scroll proposals", async kind => {
    const driver = new ScrollDriver(); driver.failScroll = kind === "failed";
    const gate: ActionPolicy = { vet: () => kind === "rejected" ? { ok: false, reason: "Origin fence" } : { ok: true } };
    const { result } = await run(mode, driver, composePolicies(createScrollNoProgressPolicy({ tolerance: 1 }), gate),
      [down, down, down, done]);
    expect(driver.executed).toBe(0);
    expect(result.truncationReason).toBeUndefined();
  });

  it("can recover through real state change or a trusted goal policy", async () => {
    const driver = new ScrollDriver();
    driver.click = async () => { driver.els = [{ role: "heading", name: "Goal reached" }]; };
    const { result } = await run(mode, driver, createScrollNoProgressPolicy({ tolerance: 1 }),
      [down, '{"action":"click","text":"Continue"}', done]);
    expect(result.truncated).not.toBe(true);
    const trusted = new ScrollDriver();
    const goal = composePolicies(createScrollNoProgressPolicy({ tolerance: 1 }), {
      vet: () => ({ ok: true }), stop: () => trusted.executed === 1,
    });
    expect((await run(mode, trusted, goal, [down, done])).result.truncated).not.toBe(true);
  });

  it("processes the last executed scroll at the step cap", async () => {
    const { result } = await run(mode, new ScrollDriver(), createScrollNoProgressPolicy({ tolerance: 1 }), [down], 1);
    expect(result).toMatchObject({ truncated: true, truncationReason: "no-progress" });
  });

  it("gives trusted goal evidence precedence at the final action boundary", async () => {
    const driver = new ScrollDriver();
    const policy = composePolicies(createScrollNoProgressPolicy({ tolerance: 1 }), {
      vet: () => ({ ok: true }), stop: () => driver.executed === 1,
    });
    const { result } = await run(mode, driver, policy, [down], 1);
    expect(result.truncated).not.toBe(true); expect(result.truncationReason).toBeUndefined();
  });

  it.each([false, true])("validates final goal observation bindings (valid=%s)", async valid => {
    const driver = new ScrollDriver();
    driver.els = [{ role: "button", name: "Continue", ref: "final-goal-ref" }];
    driver.scroll = async () => {
      driver.executed++;
      if (valid) driver.els = [{ role: "button", name: "Goal reached", ref: "final-goal-ref" }];
    };
    const stop = vi.fn((_steps: unknown, ctx: PolicyContext) => ctx.elements.some(e => e.name === "Goal reached"));
    const policy = composePolicies(createScrollNoProgressPolicy({ tolerance: 1 }), { vet: () => ({ ok: true }), stop });
    const events: TraceEvent[] = [];
    const trace = startTrace({ emit: event => events.push(event) }, "test").scope("final-goal");
    const llm = new ScriptedLlm([down, "[]"]);
    const complete = vi.spyOn(llm, "complete");
    const opts = {
      driver, llm, policy, baseUrl: driver.url, maxSteps: 1, trace, tracePhase: "heal" as const,
      perceive: async (elements: PageElement[]) => elements.map(e =>
        driver.executed ? { ...e, name: "Goal reached" } : e),
    };
    const result = mode === "discover" ? await discover("Reach the goal", opts) : await explore("Reach the goal", opts);
    expect(driver.executed).toBe(1);
    expect(Boolean(result.truncated)).toBe(!valid);
    expect(stop).toHaveBeenCalledTimes(valid ? 2 : 1);
    expect(complete).toHaveBeenCalledTimes(mode === "discover" ? 2 : 1);
    const gates = events.filter(e => e.kind === "gate" && e.payload.gate === "perception-binding");
    expect(gates).toHaveLength(valid ? 0 : 1);
    if (!valid) {
      expect(gates[0]?.phase).toBe(mode === "discover" ? "heal" : "explore");
      expect(JSON.stringify(gates)).not.toMatch(/Continue|Goal reached|final-goal-ref/);
      if ("findings" in result) expect(result.findings).toEqual([]);
    } else {
      expect(result.truncationReason).toBeUndefined();
    }
  });

  it("recovers after asynchronous lazy loading following a suspected scroll cycle", async () => {
    const driver = new ScrollDriver();
    let loading: Promise<void> | undefined;
    const llm = new ScriptedLlm([down, '{"action":"pressKey","key":"Shift"}', done]);
    driver.pressKey = async () => {
      loading = new Promise(resolve => setTimeout(() => {
        driver.els = [...driver.els, { role: "button", name: "Loaded target" }]; resolve();
      }, 5));
    };
    driver.settle = async () => { await loading; };
    const policy = createScrollNoProgressPolicy({ tolerance: 1, recoveryTurns: 1 });
    const opts = { driver, llm, policy, baseUrl: driver.url };
    const result = mode === "discover" ? await discover("Lazy content", opts) : await explore("Lazy content", opts);
    expect(driver.els.some(e => e.name === "Loaded target")).toBe(true);
    expect(result.truncated).not.toBe(true);
  });

  it("preserves new HTTP 500 and console errors caused by an executed scroll", async () => {
    const driver = new ScrollDriver();
    const original = driver.observe.bind(driver);
    driver.observe = async () => {
      const evidence = await original();
      if (driver.executed) evidence.logic = {
        requests: [{ method: "GET", url: "https://app/lazy-error", status: 500 }],
        console: [{ type: "error", text: "Lazy request failed" }],
      };
      return evidence;
    };
    const { result } = await run(mode, driver, createScrollNoProgressPolicy({ tolerance: 1 }), [down, done]);
    expect(result.truncationReason).toBe("no-progress");
    if ("findings" in result) {
      expect(result.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "failed-request", detail: expect.stringContaining("500") }),
        expect.objectContaining({ kind: "console-error", detail: expect.stringContaining("Lazy request failed") }),
      ]));
    } else {
      expect(result.assertions.some(a => a.kind === "no-failed-requests" || a.kind === "no-console-errors")).toBe(false);
    }
  });

  it("leaves disabled/unsupported behavior unchanged and isolates concurrent runs", async () => {
    const disabled = new ScrollDriver(); const probe = vi.spyOn(disabled, "scrollState");
    expect((await run(mode, disabled, undefined, [down, down, done])).result.truncated).not.toBe(true);
    expect(probe).not.toHaveBeenCalled();
    const config = createScrollNoProgressPolicy({ tolerance: 1 });
    const unsupported = new ScrollDriver(); unsupported.supported = false;
    const [a, b] = await Promise.all([
      run(mode, new ScrollDriver(), config, [down, done]), run(mode, unsupported, config, [down, down, done]),
    ]);
    expect(a.result.truncated).toBe(true); expect(b.result.truncated).not.toBe(true);
    expect((await run(mode, new ScrollDriver(), config, [done])).result.truncated).not.toBe(true);
  });

  it("ignores a moving snapshot interval and preserves real error/status evidence", async () => {
    const driver = new ScrollDriver();
    driver.snapshot = async () => { driver.y += 1; return driver.els; };
    driver.observe = async () => ({ execution: { actions: [], navigated: false, finalUrl: driver.url, blocked: false },
      perception: {}, logic: { requests: [{ method: "GET", url: "https://app/error", status: 500 }], console: [] } });
    const { result } = await run(mode, driver, createScrollNoProgressPolicy({ tolerance: 1 }), [down, down, done]);
    expect(result.truncationReason).toBeUndefined();
    if ("assertions" in result) expect(result.assertions.some(a => a.kind === "no-failed-requests")).toBe(false);
    expect((await driver.observe()).logic.requests[0]!.status).toBe(500);
  });

  it("preserves lifecycle through the budget driver without detector model calls", async () => {
    const driver = new ScrollDriver();
    const llm = new ScriptedLlm([down, done]);
    const calls = vi.spyOn(llm, "complete");
    const options = { driver, llm, baseUrl: driver.url, policy: createScrollNoProgressPolicy({ tolerance: 1 }),
      budget: { maxModelCalls: 10 } };
    const result = mode === "discover" ? await discover("Goal", options) : await explore("Goal", options);
    expect(result.truncationReason).toBe("no-progress");
    expect(calls).toHaveBeenCalledTimes(mode === "discover" ? 3 : 2);
  });
});
