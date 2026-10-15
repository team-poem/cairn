import { afterEach, expect, it, vi } from "vitest";
import { BudgetScope, BudgetExceededError, validateRunBudget } from "../src/core/budget.js";
import { discover } from "../src/core/discover/index.js";
import { explore } from "../src/core/explore/index.js";
import { runScenario } from "../src/run.js";
import { runSuite, hashCase } from "../src/suite.js";
import { FakeDriver } from "../src/adapters/drivers/fake.js";
import { StubDriver, ScriptedLlm } from "./support/doubles.js";
import { postJsonWithRetry } from "../src/adapters/llm/http.js";
import { flagBudget } from "../src/cli-args.js";
import { finalizeVerdict, runHarness } from "../src/core/pipeline.js";
import type { Evidence, Scenario, TraceEvent } from "../src/index.js";
import type { Driver, Result } from "../src/index.js";
import { combineSignals } from "../src/core/abort.js";

const evidence: Evidence = { execution: { actions: [], navigated: true, blocked: false, finalUrl: "https://shop/done" },
  perception: {}, logic: { requests: [], console: [] } };
const scenario: Scenario = { name: "checkout", steps: [{ kind: "goto", url: "https://shop" },
  { kind: "click", target: { text: "Checkout" } }], assertions: [{ kind: "navigated", to: "shop/done" }] };
const reporter = { emit: vi.fn(async () => {}) };
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("checks elapsed time before a custom dispatch even when the deadline timer has not fired", async () => {
  fakeClock();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const charge = vi.fn(async () => {});
  const out = await runScenario({ ...scenario, steps: [scenario.steps[0]!, { kind: "custom", name: "charge", params: {} }] }, {
    driver: new FakeDriver({ evidence }), reporter, budget: { timeoutMs: 10 }, actions: { charge },
    onStep: () => { now = 11; },
  });
  expect(out.result.verdict.failure).toBe("budget");
  expect(charge).not.toHaveBeenCalled();
  expect(out.result.evidence.execution.actions).toHaveLength(1);
});

it("rechecks the deadline after a host's handler selection before executing it", async () => {
  fakeClock();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const execute = vi.fn(async () => {});
  const result = await runHarness({ driver: new FakeDriver({ evidence }), reporter,
    context: { provide: async () => ({ intent: "checkout" }) }, planner: { plan: async () => scenario },
    critic: { judge: async () => ({ passed: true, results: [] }) },
  }, "checkout", { budget: { timeoutMs: 10 }, stepHandlers: [{ supports: () => { now = 11; return true; }, execute }] });
  expect(result.verdict.failure).toBe("budget");
  expect(execute).not.toHaveBeenCalled();
});

it("marks an inflight custom action uncertain and awaits it without dispatching the next step", async () => {
  fakeClock();
  let ready!: () => void;
  const dispatched = new Promise<void>(resolve => { ready = resolve; });
  let finish!: () => void;
  const charge = vi.fn(() => new Promise<void>(resolve => { finish = resolve; ready(); }));
  const driver = new FakeDriver({ evidence });
  let returned = false;
  const pending = runScenario({ ...scenario, steps: [{ kind: "custom", name: "charge", params: {} }, ...scenario.steps] }, {
    driver, reporter, budget: { timeoutMs: 10 }, actions: { charge },
  }).then(result => { returned = true; return result; });
  await dispatched;
  await vi.advanceTimersByTimeAsync(11);
  expect(returned).toBe(false);
  finish();
  const out = await pending;
  expect(out.result.verdict.budget?.operation).toEqual({ name: "step.execute", outcome: "unknown" });
  expect(charge).toHaveBeenCalledTimes(1);
  expect(driver.clicked).toEqual([]);
  expect(out.healedScenario).toBeUndefined();
});

it("awaits an inflight custom step healer and records uncertain repair", async () => {
  fakeClock();
  let ready!: () => void;
  const repairing = new Promise<void>(resolve => { ready = resolve; });
  let finish!: () => void;
  const driver = new StubDriver("https://shop");
  const pending = runHarness({ driver, reporter,
    context: { provide: async () => ({ intent: "checkout" }) },
    planner: { plan: async () => ({ ...scenario, steps: [{ kind: "click", target: { text: "Checkout" }, expect: { url: "https://shop/done" } }] }) },
    critic: { judge: async () => ({ passed: true, results: [] }) },
  }, "checkout", { budget: { timeoutMs: 10 }, expectTimeoutMs: 0,
    stepHealer: { heal: () => new Promise(resolve => { finish = () => resolve(null); ready(); }) },
  });
  await repairing;
  await vi.advanceTimersByTimeAsync(11);
  finish();
  const result = await pending;
  expect(result.verdict.budget?.operation).toEqual({ name: "step.heal", outcome: "unknown" });
  expect(result.evidence.execution.actions).toMatchObject([{ step: { kind: "click" }, ok: true }]);
});

it.each([false, true])("drains concurrent semantic judgments before returning (late rejection: %s)", async rejectLate => {
  let finish!: () => void;
  let ready!: () => void;
  const stopped = new Promise<void>(resolve => { ready = resolve; });
  const complete = vi.fn((_prompt: string, options?: { signal?: AbortSignal }) => new Promise<string>((resolve, reject) => {
    options?.signal?.addEventListener("abort", ready, { once: true });
    finish = () => rejectLate ? reject(new Error("late provider failure")) : resolve('{"passed":true}');
  }));
  let returned = false;
  const emit = vi.fn(async () => {});
  const pending = runScenario({ ...scenario, assertions: [{ kind: "expect", criterion: "one" }, { kind: "expect", criterion: "two" }] }, {
    driver: new FakeDriver({ evidence }), reporter: { emit }, budget: { maxModelCalls: 1 }, llm: { id: "parallel", complete },
  }).then(result => { returned = true; return result; });
  await stopped;
  await new Promise(resolve => setImmediate(resolve));
  expect(returned).toBe(false);
  expect(emit).not.toHaveBeenCalled();
  finish();
  const out = await pending;
  expect(out.result.verdict.budget).toMatchObject({ modelCalls: 1, operation: { name: "model.complete", outcome: "unknown" } });
  expect(complete).toHaveBeenCalledTimes(1);
  expect(emit).toHaveBeenCalledTimes(1);
});

it("supports frozen drivers, optional capabilities and private receivers with or without a budget", async () => {
  for (const budget of [undefined, { maxModelCalls: 0 }]) {
    const inner = new FakeDriver({ evidence });
    const keys = ["goto", "click", "doubleClick", "hover", "type", "locate", "select", "pressKey", "scroll", "screenshot", "snapshot", "settle", "observe", "close"] as const;
    const frozen = Object.freeze(Object.fromEntries(keys.map(key => [key, inner[key].bind(inner)]))) as unknown as Driver;
    const out = await runScenario(scenario, { driver: frozen, reporter, budget });
    expect(out.result.verdict.passed).toBe(true);
    expect(inner.closed).toBe(false);
  }
  class PrivateDriver extends FakeDriver {
    #value = "private screenshot";
    override async screenshot() { return this.#value; }
  }
  const scope = new BudgetScope({});
  const inner = new PrivateDriver({ evidence });
  const wrapped = scope.driver(inner);
  expect("screenshot" in wrapped).toBe(true);
  expect(scope.driver(wrapped)).toBe(wrapped);
  expect(await wrapped.screenshot()).toBe("private screenshot");
  await wrapped.close();
  expect(inner.closed).toBe(true);
  scope.dispose();
});

it("does not start the next suite case while a previous semantic request is still pending", async () => {
  const cases = ["first", "second"].map(id => ({ id, intent: "checkout", url: "https://shop" }));
  let ready!: () => void;
  const stopped = new Promise<void>(resolve => { ready = resolve; });
  let finish!: () => void;
  const complete = vi.fn((_prompt: string, options?: { signal?: AbortSignal }) => {
    if (complete.mock.calls.length > 1) return Promise.resolve('{"passed":true}');
    options?.signal?.addEventListener("abort", ready, { once: true });
    return new Promise<string>(resolve => { finish = () => resolve('{"passed":true}'); });
  });
  const load = vi.fn(async (ref: string) => {
    const c = cases.find(value => ref.endsWith(`/${value.id}.skill.json`))!;
    return { ...scenario, caseHash: hashCase(c), assertions: [
      { kind: "expect" as const, criterion: "one" }, { kind: "expect" as const, criterion: "two" },
    ] };
  });
  const pending = runSuite(cases, { budget: { maxModelCalls: 1 }, reporter,
    driverFactory: () => new FakeDriver({ evidence }), llm: { id: "parallel", complete },
    store: { load, freeze: async ref => ref },
  });
  await stopped;
  await new Promise(resolve => setImmediate(resolve));
  expect(load).toHaveBeenCalledTimes(1);
  finish();
  const suite = await pending;
  expect(load).toHaveBeenCalledTimes(2);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(suite.verdicts.map(value => value.verdict.failure)).toEqual(["budget", "budget"]);
});

it("publishes the final freeze failure with replay evidence and usage, never the buffered green", async () => {
  const c = { id: "freeze-failure", intent: scenario.name, url: "https://shop" };
  const reports: Result[] = [];
  const events: TraceEvent[] = [];
  const suite = await runSuite([c], { budget: { maxModelCalls: 1 },
    driverFactory: () => new FakeDriver({ evidence, failOn: ["Checkout"], elements: [{ role: "button", name: "Pay" }] }),
    llm: new ScriptedLlm(['{"name":"Pay","role":"button"}']), reporter: { emit: async result => { reports.push(result); } },
    store: { load: async () => ({ ...scenario, caseHash: hashCase(c) }), freeze: async () => { throw new Error("disk full"); } },
    trace: { emit: event => events.push(event) },
  });
  const result = suite.verdicts[0]!;
  expect(result.verdict).toMatchObject({ passed: false, failure: "environment", detail: "case crashed: disk full" });
  expect(result.usage.llmCalls).toBe(1);
  expect(result.heals).toBe(1);
  expect(reports).toHaveLength(1);
  expect(reports[0]?.verdict).toEqual(result.verdict);
  expect(reports[0]?.verdict.proof).toBeUndefined();
  expect(reports[0]?.usage).toEqual(result.usage);
  expect(reports[0]?.evidence.execution.actions.length).toBeGreaterThan(0);
  expect(events.find(event => event.kind === "case-end")?.payload).toMatchObject({ verdict: result.verdict, usage: result.usage });
});

it("composes cancellation without AbortSignal.any and releases listeners on completion or abort", async () => {
  vi.stubGlobal("AbortSignal", new Proxy(AbortSignal, { get: (target, key, receiver) =>
    key === "any" ? undefined : Reflect.get(target, key, receiver) }));
  const caller = new AbortController();
  const other = new AbortController();
  const remove = vi.spyOn(caller.signal, "removeEventListener");
  const removeOther = vi.spyOn(other.signal, "removeEventListener");
  const combined = combineSignals([caller.signal, other.signal]);
  const reason = new Error("caller stopped");
  caller.abort(reason);
  expect(combined.signal.reason).toBe(reason);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(removeOther).toHaveBeenCalledTimes(1);
  other.abort(new Error("later"));
  expect(combined.signal.reason).toBe(reason);
  combined.dispose();
  expect(remove).toHaveBeenCalledTimes(1);
  expect(combineSignals([caller.signal]).signal.reason).toBe(reason);

  const active = new AbortController();
  const activeRemove = vi.spyOn(active.signal, "removeEventListener");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify("answer"))));
  const scope = new BudgetScope({ maxModelCalls: 1 });
  const result = await scope.llm({ id: "http", complete: (_prompt, options) => postJsonWithRetry<string>(
    "https://provider.invalid", { headers: {}, body: "{}" }, { signal: options?.signal },
  ) }).complete("prompt", { signal: active.signal });
  expect(result).toBe("answer");
  expect(activeRemove).toHaveBeenCalledTimes(1);
  scope.dispose();
});

it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid allowances %s", n => {
  expect(() => validateRunBudget({ maxModelCalls: n })).toThrow();
  expect(() => validateRunBudget({ timeoutMs: n })).toThrow();
});

it("validates CLI zero budgets and malformed flags", () => {
  expect(flagBudget(new Map([["max-model-calls", "0"], ["run-timeout", "10"]]))).toEqual({ maxModelCalls: 0, timeoutMs: 10 });
  expect(() => flagBudget(new Map([["run-timeout", true]]))).toThrow();
  expect(flagBudget(new Map())).toBeUndefined();
});

it("reserves before dispatch and never refunds failures", async () => {
  const scope = new BudgetScope({ maxModelCalls: 1 });
  const complete = vi.fn(async () => { throw new Error("provider failed"); });
  const client = scope.llm({ id: "fake", complete });
  await expect(client.complete("first")).rejects.toThrow("provider failed");
  await expect(client.complete("second")).rejects.toBeInstanceOf(BudgetExceededError);
  expect(complete).toHaveBeenCalledTimes(1);
  scope.dispose();
});

it("concurrent admissions cannot overspend and discard a pending reply after exhaustion", async () => {
  const scope = new BudgetScope({ maxModelCalls: 1 });
  let finish!: (value: string) => void;
  const complete = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  const client = scope.llm({ id: "concurrent", complete });
  const first = client.complete("first").catch(e => e);
  await expect(client.complete("second")).rejects.toMatchObject({ budget: { modelCalls: 1 } });
  finish("late");
  expect(await first).toBeInstanceOf(BudgetExceededError);
  expect(complete).toHaveBeenCalledTimes(1);
  scope.dispose();
});

it("locator repair and outcome rediscovery do not receive separate allowances", async () => {
  const complete = vi.fn(async () => '{"name":"Pay","role":"button"}');
  const out = await runScenario({ ...scenario, assertions: [{ kind: "navigated", to: "never" }] }, {
    driver: new FakeDriver({ evidence, failOn: ["Checkout"], elements: [{ name: "Pay", role: "button" }] }),
    reporter, heal: true, llm: { id: "fake", complete }, budget: { maxModelCalls: 1 },
  });
  expect(complete).toHaveBeenCalledTimes(1);
  expect(out.result.verdict.budget).toMatchObject({ modelCalls: 1, phase: "outcome-heal" });
  expect(out.healedScenario).toBeUndefined();
  expect(out.result.evidence.execution.actions.length).toBeGreaterThan(0);
  expect(finalizeVerdict(out.result.verdict).failure).toBe("budget");
});

it("surgical repair shares the admission gate and cannot fall through after exhaustion", async () => {
  const driver = new StubDriver("https://shop");
  const complete = vi.fn(async () => "unused");
  const out = await runScenario({ ...scenario, steps: [{ kind: "click", target: { text: "Checkout" },
    intent: "finish order", expect: { url: "https://shop/done" } }] }, {
    driver, reporter, heal: true, expectTimeoutMs: 0,
    llm: { id: "fake", complete }, budget: { maxModelCalls: 0 },
  });
  expect(out.result.verdict.budget?.phase).toBe("step-heal");
  expect(out.result.evidence.execution.actions).toMatchObject([{ step: { kind: "click" }, ok: true }]);
  expect(complete).not.toHaveBeenCalled();
  expect(out.healedScenario).toBeUndefined();
});

it("late custom judgment cannot publish a success through the low-level harness", async () => {
  fakeClock();
  let finish!: (value: { passed: boolean; results: [] }) => void;
  let ready!: () => void;
  const judging = new Promise<void>(resolve => { ready = resolve; });
  const emit = vi.fn(async () => {});
  const pending = runHarness({ driver: new FakeDriver({ evidence }),
    context: { provide: async () => ({ intent: "checkout" }) },
    planner: { plan: async () => scenario },
    critic: { judge: () => new Promise(resolve => { finish = resolve; ready(); }) }, reporter: { emit },
  }, "checkout", { budget: { timeoutMs: 10 } });
  await judging;
  await vi.advanceTimersByTimeAsync(11);
  finish({ passed: true, results: [] });
  const result = await pending;
  expect(result.verdict.failure).toBe("budget");
  expect(emit).toHaveBeenCalledTimes(1);
  expect(emit).toHaveBeenCalledWith(result);
});

it("a zero deadline emits one complete case lifecycle without allocating a driver", async () => {
  const events: TraceEvent[] = [];
  const driverFactory = vi.fn(() => new FakeDriver({ evidence }));
  const load = vi.fn(async () => scenario);
  const suite = await runSuite([{ id: "zero", intent: "done", url: "https://shop" }], {
    driverFactory, reporter, budget: { timeoutMs: 0 },
    store: { load, freeze: async ref => ref }, trace: { emit: event => events.push(event) },
  });
  expect(suite.verdicts[0]?.verdict.failure).toBe("budget");
  expect(driverFactory).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
  expect(events.map(e => e.kind)).toEqual(["trace", "case-start", "budget-exhausted", "case-end", "run-end"]);
});

it("runtime budgets do not change a successful replay's contract", async () => {
  const run = (budget?: { maxModelCalls: number }) => runScenario(scenario, {
    driver: new FakeDriver({ evidence }), reporter, budget,
  });
  const plain = await run();
  const controlled = await run({ maxModelCalls: 0 });
  expect(controlled.result.verdict.contract).toEqual(plain.result.verdict.contract);
});

it("a host's typed budget verdict is never treated as a healable application failure", async () => {
  const complete = vi.fn(async () => "unused");
  const result = await runScenario(scenario, { driver: new FakeDriver({ evidence, failOn: ["Checkout"] }),
    reporter, heal: true, llm: { id: "fake", complete },
    critic: { judge: async () => ({ passed: false, results: [], failure: "budget", budget: {
      limit: "time", configured: { timeoutMs: 0 }, elapsedMs: 0, modelCalls: 0, phase: "host-judge",
    } }) },
  });
  expect(result.result.verdict.failure).toBe("budget");
  expect(result.healedScenario).toBeUndefined();
  // The failed locator may try one repair before judgment; the budget verdict cannot start rediscovery.
  expect(complete).toHaveBeenCalledTimes(1);
});

it("captures limits before awaits and removes timers and caller listeners on completion", async () => {
  fakeClock();
  const caller = new AbortController();
  const remove = vi.spyOn(caller.signal, "removeEventListener");
  const budget = { maxModelCalls: 1, timeoutMs: 100 };
  const scope = new BudgetScope(budget, caller.signal);
  budget.maxModelCalls = 99;
  scope.reserve();
  expect(() => scope.reserve()).toThrow(BudgetExceededError);
  scope.dispose();
  expect(vi.getTimerCount()).toBe(0);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
});

it("non-cloneable host action params cannot crash the deadline timer", async () => {
  fakeClock();
  const scope = new BudgetScope({ timeoutMs: 10 });
  scope.recordAction({ step: { kind: "custom", name: "host", params: { callback: () => {} } }, ok: true });
  await vi.advanceTimersByTimeAsync(11);
  expect(() => scope.check()).toThrow(BudgetExceededError);
  scope.dispose();
});

it("mid-flight caller cancellation keeps its reason even after the deadline passes", async () => {
  fakeClock();
  const caller = new AbortController();
  const scope = new BudgetScope({ timeoutMs: 10 }, caller.signal);
  let finish!: (value: string) => void;
  const pending = scope.llm({ id: "late", complete: () => new Promise(resolve => { finish = resolve; }) })
    .complete("prompt").catch(e => e);
  const reason = new Error("caller stop");
  caller.abort(reason);
  await vi.advanceTimersByTimeAsync(11);
  finish("late");
  expect(await pending).toBe(reason);
  expect(scope.modelCalls).toBe(1);
  scope.dispose();
});

it("the final reporter is outside the deadline and runs exactly once", async () => {
  fakeClock();
  const emit = vi.fn(async () => { await vi.advanceTimersByTimeAsync(101); });
  const out = await runScenario(scenario, { driver: new FakeDriver({ evidence }), reporter: { emit }, budget: { timeoutMs: 100 } });
  expect(out.result.verdict.passed).toBe(true);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("inflight HTTP cancellation propagates without transport retries", async () => {
  const caller = new AbortController();
  const reason = new Error("stopped");
  const fetch = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  vi.stubGlobal("fetch", fetch);
  const pending = postJsonWithRetry("https://provider.invalid", { headers: {}, body: "{}" }, { signal: caller.signal });
  caller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("healthy frozen replay with a zero model budget stays model-free", async () => {
  const complete = vi.fn(async () => "unused");
  const driver = new FakeDriver({ evidence });
  const out = await runScenario(scenario, { driver, reporter, llm: { id: "fake", complete }, budget: { maxModelCalls: 0 } });
  expect(out.result.verdict.passed).toBe(true);
  expect(out.result.usage?.llmCalls).toBe(0);
  expect(complete).not.toHaveBeenCalled();
  expect(driver.closed).toBe(false);
});

it("discovery decisions and assertion proposals consume one allowance", async () => {
  const llm = new ScriptedLlm(['{"action":"done"}', '[]']);
  await expect(discover("checkout", { driver: new FakeDriver({ evidence }), llm, budget: { maxModelCalls: 1 } }))
    .rejects.toMatchObject({ budget: { limit: "model-calls", modelCalls: 1 } });
});

it("locator exhaustion does not fall through to rediscovery or freeze a repair", async () => {
  const complete = vi.fn(async () => "unused");
  const events: TraceEvent[] = [];
  const out = await runScenario(scenario, { driver: new FakeDriver({ evidence, failOn: ["Checkout"] }),
    reporter, heal: true, llm: { id: "fake", complete }, budget: { maxModelCalls: 0 }, trace: { emit: e => events.push(e) } });
  expect(out.result.verdict.failure).toBe("budget");
  expect(out.result.verdict.budget?.phase).toBe("locator-heal");
  expect(out.healedScenario).toBeUndefined();
  expect(complete).not.toHaveBeenCalled();
  expect(events.filter(e => e.kind === "case-end")).toHaveLength(1);
  expect(events.at(-1)?.kind).toBe("run-end");
});

it("late model replies cannot dispatch actions, even when the client ignores cancellation", async () => {
  fakeClock();
  let ready!: () => void;
  const dispatched = new Promise<void>(resolve => { ready = resolve; });
  let finish!: (value: string) => void;
  const driver = new FakeDriver({ evidence });
  let signal: AbortSignal | undefined;
  const pending = discover("checkout", { driver, budget: { timeoutMs: 10 }, llm: { id: "late",
    complete: (_prompt, options) => { signal = options?.signal; return new Promise(resolve => { finish = resolve; ready(); }); },
  } }).catch(error => error);
  await dispatched;
  await vi.advanceTimersByTimeAsync(11);
  expect(signal?.aborted).toBe(true);
  finish('{"action":"click","target":{"text":"Checkout"}}');
  expect(await pending).toBeInstanceOf(BudgetExceededError);
  expect(driver.clicked).toEqual([]);
});

it("deadline during a browser operation waits for settlement but never repeats it or continues", async () => {
  fakeClock();
  let ready!: () => void;
  const dispatched = new Promise<void>(resolve => { ready = resolve; });
  let finish!: () => void;
  const driver = new FakeDriver({ evidence });
  const goto = vi.spyOn(driver, "goto").mockImplementation(() => new Promise(resolve => { finish = resolve; ready(); }));
  const pending = runScenario(scenario, { driver, reporter, heal: true, budget: { timeoutMs: 10 } });
  await dispatched;
  await vi.advanceTimersByTimeAsync(11);
  finish();
  const out = await pending;
  expect(out.result.verdict.budget).toMatchObject({ limit: "time", operation: { name: "driver.goto", outcome: "unknown" } });
  expect(out.result.verdict.passed).toBe(false);
  expect(goto).toHaveBeenCalledTimes(1);
  expect(driver.clicked).toEqual([]);
  expect(driver.closed).toBe(false);
});

it("caller cancellation remains distinguishable from budget exhaustion", async () => {
  const abort = new AbortController();
  const reason = new Error("user stopped");
  abort.abort(reason);
  await expect(runScenario(scenario, { driver: new FakeDriver({ evidence }), reporter, signal: abort.signal,
    budget: { maxModelCalls: 1 } })).rejects.toBe(reason);
});

it("suite cases get independent allowances; discovery and replay judgment share each allowance", async () => {
  const closes: ReturnType<typeof vi.spyOn>[] = [];
  const frozen: Scenario[] = [];
  const suite = await runSuite(["a", "b"].map(id => ({ id, intent: "done", url: "https://shop", expect: ["receipt visible"] })), {
    budget: { maxModelCalls: 2 }, reporter, heal: true,
    llm: { id: "fake", complete: async prompt => prompt.includes("assertion") ? "[]" : '{"action":"done"}' },
    driverFactory: () => { const d = new StubDriver("https://shop"); closes.push(vi.spyOn(d, "close")); return d; },
    store: { load: async () => { throw new Error("missing"); }, freeze: async (ref, value) => { frozen.push(value); return ref; } },
  });
  expect(suite.verdicts.map(v => v.verdict.failure)).toEqual(["budget", "budget"]);
  expect(suite.verdicts.map(v => v.verdict.budget?.modelCalls)).toEqual([2, 2]);
  expect(suite.usage.llmCalls).toBe(4);
  expect(closes.every(close => close.mock.calls.length === 1)).toBe(true);
  expect(frozen).toHaveLength(2); // completed discovery only; no unverified repair is persisted
});

it("exploration uses the same admission limit", async () => {
  const complete = vi.fn(async () => "unused");
  await expect(explore("survey", { driver: new FakeDriver({ evidence }), baseUrl: "https://shop", llm: { id: "fake", complete },
    budget: { maxModelCalls: 0 } })).rejects.toBeInstanceOf(BudgetExceededError);
  expect(complete).not.toHaveBeenCalled();
});

it("HTTP backoff stops on the shared deadline rather than dispatching a retry", async () => {
  fakeClock();
  const fetch = vi.fn(async () => ({ ok: false, status: 429 }) as Response);
  vi.stubGlobal("fetch", fetch);
  const scope = new BudgetScope({ timeoutMs: 10 });
  const pending = postJsonWithRetry("https://provider.invalid", { headers: {}, body: "{}" }, { signal: scope.signal }).catch(e => e);
  await vi.advanceTimersByTimeAsync(11);
  expect(await pending).toBeInstanceOf(BudgetExceededError);
  expect(fetch).toHaveBeenCalledTimes(1);
  scope.dispose();
});

it("transport retries remain inside one engine admission", async () => {
  fakeClock();
  const fetch = vi.fn().mockResolvedValueOnce(new Response("busy", { status: 429 }))
    .mockResolvedValueOnce(new Response(JSON.stringify("answer")));
  vi.stubGlobal("fetch", fetch);
  const scope = new BudgetScope({ maxModelCalls: 1, timeoutMs: 1000 });
  const pending = scope.llm({ id: "http", complete: (_prompt, opts) => postJsonWithRetry<string>(
    "https://provider.invalid", { headers: {}, body: "{}" }, { signal: opts?.signal },
  ) }).complete("prompt");
  await vi.advanceTimersByTimeAsync(501);
  expect(await pending).toBe("answer");
  expect(scope.modelCalls).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  scope.dispose();
});

it("a late store completion cannot publish a successful case or schedule another repair", async () => {
  fakeClock();
  const c = { id: "store", intent: scenario.name, url: "https://shop" };
  const events: TraceEvent[] = [];
  let ready!: () => void;
  const freezing = new Promise<void>(resolve => { ready = resolve; });
  let finish!: (ref: string) => void;
  const freeze = vi.fn(() => new Promise<string>(resolve => { finish = resolve; ready(); }));
  const emit = vi.fn(async () => {});
  const pending = runSuite([c], { budget: { timeoutMs: 1000, maxModelCalls: 1 },
    driverFactory: () => new FakeDriver({ evidence, failOn: ["Checkout"], elements: [{ role: "button", name: "Pay" }] }),
    llm: new ScriptedLlm(['{"name":"Pay","role":"button"}']), reporter: { emit },
    store: { load: async () => ({ ...scenario, caseHash: hashCase(c) }), freeze },
    trace: { emit: event => events.push(event) },
  });
  await freezing;
  await vi.advanceTimersByTimeAsync(1001);
  finish("store");
  const result = await pending;
  expect(result.verdicts[0]?.verdict.budget?.operation).toEqual({ name: "store.freeze", outcome: "unknown" });
  expect(result.passed).toBe(false);
  expect(freeze).toHaveBeenCalledTimes(1);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(events.filter(e => e.kind === "case-end")).toHaveLength(1);
  expect(events.filter(e => e.kind === "freeze")).toHaveLength(0);
});
