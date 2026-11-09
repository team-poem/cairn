import { afterEach, describe, expect, it, vi } from "vitest";
import { runHarness, type RunHarnessOptions } from "../../src/core/pipeline.js";
import { LlmStepHealer } from "../../src/core/step-heal.js";
import { runScenario } from "../../src/run.js";
import { InlineContextProvider } from "../../src/adapters/context/inline.js";
import { StaticPlanner } from "../../src/adapters/planners/static.js";
import { AssertionCritic } from "../../src/adapters/critics/assertion.js";
import type { StepHealer } from "../../src/core/ports.js";
import type { NetworkRequest, Scenario, Step, StepProgress } from "../../src/core/types.js";
import { startTrace, type TraceEvent } from "../../src/core/trace.js";
import { StubDriver } from "../support/doubles.js";
import { useClockDigest } from "../support/clock-digest.js";

useClockDigest();
afterEach(() => vi.useRealTimers());
const original: Step = { kind: "click", target: { text: "Open" }, expect: { url: "app/detail" } };
const next: Step = { kind: "click", target: { text: "Next" } };
const scenario: Scenario = { name: "late arrival", steps: [original, next], assertions: [{ kind: "navigated", to: "app/detail" }] };
const reporter = { emit: async () => {} };

function run(driver: StubDriver, stepHealer?: StepHealer, opts: RunHarnessOptions = {}, sc = scenario) {
  return runHarness({ driver, context: new InlineContextProvider(), planner: new StaticPlanner(sc),
    critic: new AssertionCritic(), reporter }, sc.name, { expectTimeoutMs: 0, stepHealer, ...opts });
}

function declines(work: () => void = () => {}): StepHealer {
  return { async heal(_step, _index, _driver, onDeclined) { work(); onDeclined?.(); return null; } };
}

describe("original post-condition after a declined repair (#341)", () => {
  it("accepts late arrival through the shipped healer without a replacement, skip or heal event", async () => {
    const driver = new StubDriver();
    const progress: StepProgress[] = [];
    const events: TraceEvent[] = [];
    const llm = { id: "scripted", complete: vi.fn(async () => {
      driver.url = "https://app/detail";
      return '{"action":"done"}';
    }) };
    const healer = new LlmStepHealer(llm);
    const result = await run(driver, healer, { onStep: p => progress.push(p),
      trace: startTrace({ emit: e => { events.push(e); } }, "test").scope("late arrival") });
    expect(result.verdict.passed).toBe(true);
    expect(driver.clicked).toEqual(["Open", "Next"]);
    expect(result.evidence.execution.actions).toEqual([{ step: original, ok: true }, { step: next, ok: true }]);
    expect(progress[0]).toMatchObject({ index: 0, step: original, ok: true });
    expect(progress[0]).not.toHaveProperty("skipped");
    expect(events.filter(e => e.kind === "heal")).toEqual([]);
    expect(events.filter(e => e.kind === "step")).toHaveLength(2);
    expect(healer.heals).toEqual([]);
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it("keeps runScenario model accounting and checkpoint capture on the original path", async () => {
    const driver = new StubDriver();
    const order: string[] = [];
    driver.snapshot = async () => { order.push(driver.url); return [{ role: "heading", name: "Detail" }]; };
    const llm = { id: "scripted", complete: vi.fn(async () => { driver.url = "https://app/detail"; return '{"action":"done"}'; }) };
    const out = await runScenario(scenario, { driver, llm, reporter, heal: true, expectTimeoutMs: 0,
      budget: { maxModelCalls: 1 }, evidenceCapture: { checkpoints: [{ id: "arrival", after: [original], elements: true }] },
      onStep: p => { order.push(`step:${p.index}`); } });
    expect(out.result.verdict.passed).toBe(true);
    expect(out.result.usage?.llmCalls).toBe(1);
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(out.healedScenario).toBeUndefined();
    expect(out.result.evidence.checkpoints?.[0]).toMatchObject({ status: "captured", complete: true,
      action: { step: { kind: "click", target: { text: "Open" } }, ok: true } });
    expect(order.indexOf("https://app/detail")).toBeLessThan(order.indexOf("step:0"));
    expect(driver.clicked).toEqual(["Open", "Next"]);
  });

  it("checks only once after decline and stops when the condition remains false", async () => {
    vi.useFakeTimers();
    const driver = new StubDriver();
    const startedAt = Date.now();
    let declinedAt: number | undefined;
    let checks = 0;
    const observe = driver.observe.bind(driver);
    driver.observe = async () => { if (declinedAt !== undefined) checks++; return observe(); };
    const pending = run(driver, declines(() => { declinedAt = Date.now(); }), { expectTimeoutMs: 400 });
    await vi.runAllTimersAsync();
    const result = await pending;
    // One recheck plus the existing final evidence read, without another polling window.
    expect(checks).toBe(2);
    expect(declinedAt).toBe(startedAt + 400);
    expect(Date.now()).toBe(declinedAt);
    expect(vi.getTimerCount()).toBe(0);
    expect(result.evidence.execution.actions).toMatchObject([{ ok: false, errorKind: "post-condition" }]);
    expect(driver.clicked).toEqual(["Open"]);
  });

  it("does not reinterpret a legacy healer's null result as no dispatch", async () => {
    const driver = new StubDriver();
    const result = await run(driver, { async heal() { driver.url = "https://app/detail"; return null; } });
    expect(result.verdict.passed).toBe(false);
    expect(driver.clicked).toEqual(["Open"]);
  });

  it("does not accept a failed repair even when its uncertain click reaches the expected page", async () => {
    const driver = new StubDriver();
    const click = driver.click.bind(driver);
    driver.click = async t => { await click(t); if (t.text === "Repair") { driver.url = "https://app/detail"; throw new Error("lost receipt"); } };
    const healer = new LlmStepHealer({ id: "scripted", complete: async () => '{"action":"click","text":"Repair"}' });
    const result = await run(driver, healer);
    expect(driver.clicked).toEqual(["Open", "Repair"]);
    expect(result.verdict.passed).toBe(false);
    expect(healer.heals).toEqual([]);
  });

  it.each(["malformed", "provider-error", "policy-rejection"])("does not certify %s as a clean decline", async mode => {
    const driver = new StubDriver();
    const healer = new LlmStepHealer({ id: "scripted", complete: async () => {
      driver.url = "https://app/detail";
      if (mode === "provider-error") throw new Error("provider failed");
      return mode === "malformed" ? "not json" : '{"action":"done"}';
    } }, 5, {}, mode === "policy-rejection" ? { policy: { vet: () => ({ ok: false, reason: "blocked" }) } } : {});
    const result = await run(driver, healer);
    expect(result.verdict.passed).toBe(false);
    expect(driver.clicked).toEqual(["Open"]);
  });

  it.each([true, false])("keeps configured locale matching during the recheck (enabled: %s)", async enabled => {
    const driver = new StubDriver();
    const result = await run(driver, declines(() => { driver.url = "https://app/tenant/detail"; }), { localePrefixes: enabled ? ["tenant"] : [] });
    expect(result.evidence.execution.actions[0]?.ok).toBe(enabled);
    expect(driver.clicked).toEqual(enabled ? ["Open", "Next"] : ["Open"]);
  });

  it("requires every URL and text condition, not only the arrival URL", async () => {
    const driver = new StubDriver();
    const step: Step = { ...original, expect: { url: "app/detail", text: "Ready", role: "heading" } };
    const result = await run(driver, declines(() => { driver.url = "https://app/detail"; }), {}, { ...scenario, steps: [step, next] });
    expect(result.verdict.passed).toBe(false);
    expect(driver.clicked).toEqual(["Open"]);
  });

  it.each(["old", "fresh", "wrong-method"])("preserves request watermark and method (%s)", async mode => {
    const driver = new StubDriver("https://app/detail");
    const requests: NetworkRequest[] = [{ url: "https://app/api/save", method: "POST", status: 200 }];
    const observe = driver.observe.bind(driver);
    driver.observe = async () => ({ ...await observe(), logic: { requests: requests.map(r => ({ ...r })), console: [] } });
    const step: Step = { ...original, expect: { requestStatus: { urlIncludes: "/api/save", method: "POST", status: 200 } } };
    const result = await run(driver, declines(() => {
      if (mode !== "old") requests.push({ url: "https://app/api/save", method: mode === "fresh" ? "POST" : "GET", status: 200 });
    }), {}, { ...scenario, steps: [step, next] });
    expect(result.verdict.passed).toBe(mode === "fresh");
    expect(driver.clicked).toEqual(mode === "fresh" ? ["Open", "Next"] : ["Open"]);
  });

  it.each(["heal", "recheck"])("preserves cancellation during %s", async phase => {
    const driver = new StubDriver();
    const abort = new AbortController();
    const reason = new Error("host stopped");
    const observe = driver.observe.bind(driver);
    const healer = declines(() => {
      driver.url = "https://app/detail";
      if (phase === "heal") abort.abort(reason);
      else driver.observe = async () => { abort.abort(reason); return observe(); };
    });
    await expect(run(driver, healer, { signal: abort.signal })).rejects.toBe(reason);
    expect(driver.clicked).toEqual(["Open"]);
  });

  describe.each([
    { mode: "without a budget", budget: undefined },
    { mode: "with an empty budget", budget: {} },
  ])("recheck read boundaries $mode", ({ budget }) => {
    it.each([
      { read: "observe", cancelled: true },
      { read: "snapshot", cancelled: true },
      { read: "observe", cancelled: false },
      { read: "snapshot", cancelled: false },
    ] as const)("preserves the original reason when $read rejects (cancelled: $cancelled)", async ({ read, cancelled }) => {
      const driver = new StubDriver();
      const abort = new AbortController();
      const reason = new Error("host stopped");
      const transport = new Error("driver transport failed");
      const progress = vi.fn();
      const screenshot = vi.spyOn(driver, "screenshot");
      const step: Step = read === "observe" ? original : { ...original, expect: { text: "Ready", role: "heading" } };
      const rejectedRead = vi.fn(async () => {
        if (cancelled) abort.abort(reason);
        throw transport;
      });
      const healer = declines(() => { driver[read] = rejectedRead; });
      await expect(run(driver, healer, { signal: abort.signal, budget, onStep: progress,
        evidenceCapture: { checkpoints: [{ id: "arrival", after: [step], screenshot: true }] },
      }, { ...scenario, steps: [step, next] })).rejects.toBe(cancelled ? reason : transport);
      expect(rejectedRead).toHaveBeenCalledTimes(1);
      expect(driver.clicked).toEqual(["Open"]);
      expect(progress).not.toHaveBeenCalled();
      expect(screenshot).not.toHaveBeenCalled();
    });

    it("preserves cancellation queued after the rejected read settles", async () => {
      const driver = new StubDriver();
      const abort = new AbortController();
      const reason = new Error("host stopped");
      const transport = new Error("driver transport failed");
      const progress = vi.fn();
      const screenshot = vi.spyOn(driver, "screenshot");
      const rejectedRead = vi.fn(() => {
        const pending = Promise.reject(transport);
        // Return the promise directly so cancellation follows the per-read guard's rejection.
        pending.catch(() => queueMicrotask(() => abort.abort(reason)));
        return pending;
      });
      const healer = declines(() => { driver.observe = rejectedRead; });
      await expect(run(driver, healer, { signal: abort.signal, budget, onStep: progress,
        evidenceCapture: { checkpoints: [{ id: "arrival", after: [original], screenshot: true }] },
      })).rejects.toBe(reason);
      expect(rejectedRead).toHaveBeenCalledTimes(1);
      expect(driver.clicked).toEqual(["Open"]);
      expect(progress).not.toHaveBeenCalled();
      expect(screenshot).not.toHaveBeenCalled();
    });

    it("does not start the text snapshot when the URL observation cancels and returns", async () => {
      const driver = new StubDriver();
      driver.els = [{ role: "heading", name: "Ready" }];
      const abort = new AbortController();
      const reason = new Error("host stopped");
      const progress = vi.fn();
      const snapshot = vi.spyOn(driver, "snapshot");
      const screenshot = vi.spyOn(driver, "screenshot");
      const observe = driver.observe.bind(driver);
      const step: Step = { ...original, expect: { url: "app/detail", text: "Ready", role: "heading" } };
      const healer = declines(() => {
        driver.url = "https://app/detail";
        driver.observe = async () => { abort.abort(reason); return observe(); };
      });
      await expect(run(driver, healer, { signal: abort.signal, budget, onStep: progress,
        evidenceCapture: { checkpoints: [{ id: "arrival", after: [step], screenshot: true }] },
      }, { ...scenario, steps: [step, next] })).rejects.toBe(reason);
      expect(snapshot).not.toHaveBeenCalled();
      expect(driver.clicked).toEqual(["Open"]);
      expect(progress).not.toHaveBeenCalled();
      expect(screenshot).not.toHaveBeenCalled();
    });
  });

  it.each(["heal", "recheck"])("preserves budget exhaustion during %s", async phase => {
    vi.useFakeTimers();
    const driver = new StubDriver();
    const observe = driver.observe.bind(driver);
    const expire = async () => { await vi.advanceTimersByTimeAsync(11); };
    const healer: StepHealer = { async heal(_step, _index, _driver, onDeclined) {
      driver.url = "https://app/detail";
      if (phase === "heal") await expire();
      else driver.observe = async () => { await expire(); return observe(); };
      onDeclined?.();
      return null;
    } };
    const result = await run(driver, healer, { budget: { timeoutMs: 10 } });
    expect(result.verdict.passed).toBe(false);
    expect(result.verdict.failure).toBe("budget");
    expect(result.verdict.budget?.operation?.name).toBe(phase === "heal" ? "step.heal" : "driver.observe");
    expect(driver.clicked).toEqual(["Open"]);
  });

  it("does not add recovery reads without a healer", async () => {
    const driver = new StubDriver();
    const observe = vi.spyOn(driver, "observe");
    const result = await run(driver);
    expect(result.verdict.passed).toBe(false);
    expect(observe).toHaveBeenCalledTimes(3); // precheck, initial poll, final evidence
    expect(driver.clicked).toEqual(["Open"]);
  });

  it("does not recheck if the healer rejects after notifying decline", async () => {
    const driver = new StubDriver();
    const reason = new Error("repair callback failed");
    await expect(run(driver, { async heal(_s, _i, _d, onDeclined) {
      driver.url = "https://app/detail";
      onDeclined?.();
      throw reason;
    } })).rejects.toBe(reason);
    expect(driver.clicked).toEqual(["Open"]);
  });

  it("does not carry a declined attempt into the next step", async () => {
    const driver = new StubDriver();
    const second: Step = { ...next, expect: { url: "app/final" } };
    const result = await run(driver, { async heal(_s, index, _d, onDeclined) {
      driver.url = index === 0 ? "https://app/detail" : "https://app/final";
      if (index === 0) onDeclined?.();
      return null;
    } }, {}, { ...scenario, steps: [original, second, { kind: "click", target: { text: "Never" } }] });
    expect(result.evidence.execution.actions.map(a => a.ok)).toEqual([true, false]);
    expect(driver.clicked).toEqual(["Open", "Next"]);
  });

  it("uses a returned replacement rather than decline notification when both are supplied", async () => {
    const driver = new StubDriver();
    const replacement: Step = { kind: "click", target: { text: "Repair" }, expect: { url: "app/detail" } };
    driver.navOn.Repair = "https://app/detail";
    const result = await run(driver, { async heal(_s, index, d, onDeclined) {
      onDeclined?.();
      await d.click({ text: "Repair" });
      return { index, step: replacement };
    } });
    expect(result.evidence.execution.actions[0]).toEqual({ step: replacement, ok: true });
    expect(driver.clicked).toEqual(["Open", "Repair", "Next"]);
  });
});
