import { afterEach, expect, it, vi } from "vitest";
import { BudgetExceededError, runWorkflow } from "../src/index.js";
import { discover } from "../src/core/discover/index.js";
import { runScenario } from "../src/run.js";
import { runHarness } from "../src/core/pipeline.js";
import { LlmCritic } from "../src/adapters/critics/llm.js";
import { FakeDriver } from "../src/adapters/drivers/fake.js";
import { ChromeDevToolsDriver } from "../src/adapters/drivers/chrome.js";
import { ScriptedLlm, StubDriver } from "./support/doubles.js";
import type { Evidence, Scenario, TraceEvent } from "../src/index.js";

const evidence: Evidence = { execution: { actions: [], navigated: true, blocked: false, finalUrl: "https://shop/done" },
  perception: {}, logic: { requests: [], console: [] } };
const scenario: Scenario = { name: "checkout", steps: [{ kind: "goto", url: "https://shop" },
  { kind: "click", target: { text: "Checkout" } }], assertions: [{ kind: "navigated", to: "shop/done" }] };
const judged: Scenario = { ...scenario, assertions: [...scenario.assertions, { kind: "expect", criterion: "the order is confirmed" }] };
const reporter = { emit: vi.fn(async () => {}) };
const judge = () => ({ id: "judge", complete: vi.fn(async (_prompt: string) => '{"passed":true,"reason":"confirmed"}') });
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
}
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { opened, open };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); reporter.emit.mockClear(); });

it("preparation, main execution and verification consume one remaining allowance", async () => {
  const driver = new StubDriver("https://shop");
  driver.els = [{ role: "button", name: "Checkout" }];
  driver.navOn.Checkout = "https://shop/done";
  const verify = vi.fn();
  const prepare = judge();
  const outcome = await runWorkflow({ budget: { maxModelCalls: 3 } }, async workflow => {
    const ready = await runScenario(judged, { workflow: workflow.borrow("prepare"), driver: new FakeDriver({ evidence }), llm: prepare, reporter });
    expect(ready.result.verdict.passed).toBe(true);
    await discover("checkout", { workflow: workflow.borrow("main"), driver, baseUrl: "https://shop",
      llm: new ScriptedLlm(['{"action":"click","text":"Checkout"}', '{"action":"done"}', "[]"]) });
    verify();
  });
  expect(outcome).toMatchObject({ status: "exhausted", participant: "main",
    budget: { limit: "model-calls", modelCalls: 3, phase: "assertions" } });
  expect(prepare.complete).toHaveBeenCalledTimes(1);
  expect(verify).not.toHaveBeenCalled();
  const [prepared, main] = outcome.participants;
  expect(prepared).toMatchObject({ name: "prepare", modelCalls: 1 });
  expect(prepared?.stop).toBeUndefined();
  expect(main).toMatchObject({ name: "main", modelCalls: 2, stop: { phase: "assertions" } });
  expect(main?.stop?.evidence?.execution.actions.map(action => action.step.kind)).toEqual(["goto", "click"]);
});

it("parallel admissions across participants cannot overdraw and pending replies are rejected", async () => {
  const replies: Array<() => void> = [];
  const complete = vi.fn(() => new Promise<string>(resolve => { replies.push(() => resolve("late")); }));
  const outcome = await runWorkflow({ budget: { maxModelCalls: 2 } }, async workflow => {
    const a = workflow.borrow("a").llm({ id: "model", complete });
    const b = workflow.borrow("b").llm({ id: "model", complete });
    const calls = Promise.all([a.complete("one"), b.complete("two"), a.complete("three")]);
    for (const reply of replies) reply();
    return calls;
  });
  expect(complete).toHaveBeenCalledTimes(2);
  expect(outcome).toMatchObject({ status: "exhausted", participant: "a", budget: { limit: "model-calls", modelCalls: 2 } });
  expect(outcome.participants).toMatchObject([
    { name: "a", modelCalls: 1, stop: { operation: { name: "model.complete", outcome: "unknown" } } },
    { name: "b", modelCalls: 1, stop: { operation: { name: "model.complete", outcome: "unknown" } } },
  ]);
});

it("failed calls keep their admission and a doubly managed client is counted once", async () => {
  const prepare = judge();
  const failing = vi.fn(async () => { throw new Error("provider down"); });
  const outcome = await runWorkflow({ budget: { maxModelCalls: 2 } }, async workflow => {
    const lease = workflow.borrow("prepare");
    const out = await runScenario(judged, { workflow: lease, llm: lease.llm(lease.llm(prepare)), driver: new FakeDriver({ evidence }), reporter });
    expect(out.result.usage?.llmCalls).toBe(1);
    const verify = workflow.borrow("verify").llm({ id: "verify", complete: failing });
    await expect(verify.complete("is it visible?")).rejects.toThrow("provider down");
    await verify.complete("retry");
  });
  expect(prepare.complete).toHaveBeenCalledTimes(1);
  expect(failing).toHaveBeenCalledTimes(1);
  expect(outcome).toMatchObject({ status: "exhausted", participant: "verify", budget: { limit: "model-calls", modelCalls: 2 } });
});

it("awaits an uncertain host mutation on expiry, rejects its late result and never retries it", async () => {
  fakeClock();
  const dispatched = gate();
  let finish!: () => void;
  const submit = vi.fn(() => new Promise<string>(resolve => { finish = () => resolve("submitted"); dispatched.open(); }));
  let late: unknown;
  let returned = false;
  const pending = runWorkflow({ budget: { timeoutMs: 10 } }, async workflow => {
    const verify = workflow.borrow("verify");
    late = await verify.operation("browser.submit", submit).catch(error => error);
    await verify.operation("browser.submit", submit);
  }).then(outcome => { returned = true; return outcome; });
  await dispatched.opened;
  await vi.advanceTimersByTimeAsync(11);
  expect(returned).toBe(false);
  finish();
  const outcome = await pending;
  expect(late).toBeInstanceOf(BudgetExceededError);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(outcome).toMatchObject({ status: "exhausted", participant: "verify",
    budget: { limit: "time", operation: { name: "browser.submit", outcome: "unknown" } } });
});

it("a late model reply cannot dispatch the next discovery action", async () => {
  fakeClock();
  const asked = gate();
  let reply!: (text: string) => void;
  const driver = new StubDriver("https://shop");
  driver.els = [{ role: "button", name: "Checkout" }];
  const pending = runWorkflow({ budget: { timeoutMs: 10 } }, async workflow =>
    discover("checkout", { workflow: workflow.borrow("main"), driver,
      llm: { id: "ignores-signal", complete: () => new Promise(resolve => { reply = resolve; asked.open(); }) } }));
  await asked.opened;
  await vi.advanceTimersByTimeAsync(11);
  reply('{"action":"click","text":"Checkout"}');
  const outcome = await pending;
  expect(driver.clicked).toEqual([]);
  expect(outcome).toMatchObject({ status: "exhausted", participant: "main",
    participants: [{ name: "main", stop: { operation: { name: "model.complete", outcome: "unknown" } } }] });
});

it("drains admitted work before one owner cleanup and admits nothing afterwards", async () => {
  fakeClock();
  const caller = new AbortController();
  const remove = vi.spyOn(caller.signal, "removeEventListener");
  const started = gate();
  let finish!: () => void;
  const upload = vi.fn(() => new Promise<void>(resolve => { finish = resolve; started.open(); }));
  let sibling: Promise<unknown> | undefined;
  let lease!: ReturnType<Parameters<Parameters<typeof runWorkflow>[1]>[0]["borrow"]>;
  let settled = false;
  const pending = runWorkflow({ budget: { timeoutMs: 1000 }, signal: caller.signal }, async workflow => {
    lease = workflow.borrow("upload");
    sibling = lease.operation("browser.upload", upload).catch(error => error);
    await started.opened;
    throw new Error("verification crashed");
  }).catch(error => error).finally(() => { settled = true; });
  await started.opened;
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  finish();
  expect(await pending).toEqual(new Error("verification crashed"));
  expect(await sibling).toBeUndefined();
  expect(upload).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  await expect(lease.driver(new FakeDriver({ evidence })).close()).resolves.toBeUndefined();
  await expect(lease.operation("browser.cleanup", async () => "x")).rejects.toThrow("closed");
});

it("mixes engine-managed and registered host work while unregistered work stays uncounted", async () => {
  const model = judge();
  const outcome = await runWorkflow({ budget: { maxModelCalls: 5 } }, async workflow => {
    const main = workflow.borrow("main");
    const result = await runHarness({ driver: new FakeDriver({ evidence }), reporter,
      context: { provide: async () => ({ intent: "checkout" }) }, planner: { plan: async () => judged },
      critic: new LlmCritic(main.llm(model)) }, "checkout", { workflow: main });
    await workflow.borrow("verify").llm(model).complete("is the order listed?");
    await model.complete("host-only work");
    return result.verdict.passed;
  });
  expect(model.complete).toHaveBeenCalledTimes(3);
  expect(outcome).toMatchObject({ status: "completed", value: true, modelCalls: 2,
    participants: [{ name: "main", modelCalls: 1 }, { name: "verify", modelCalls: 1 }] });
  expect(reporter.emit).toHaveBeenCalledTimes(1);
});

it("drains a rejected concurrent engine call through owned-driver cleanup and its final trace", async () => {
  const dispatched = gate();
  const finishNavigation = gate();
  const closing = gate();
  const finishClose = gate();
  const events: TraceEvent[] = [];
  const error = new Error("verification crashed");
  const goto = vi.spyOn(ChromeDevToolsDriver.prototype, "goto").mockImplementation(async () => {
    dispatched.open();
    await finishNavigation.opened;
  });
  const close = vi.spyOn(ChromeDevToolsDriver.prototype, "close").mockImplementation(async () => {
    closing.open();
    await finishClose.opened;
  });
  let returned = false;
  const pending = runWorkflow({ budget: {} }, async workflow => Promise.all([
    runScenario(scenario, { workflow: workflow.borrow("replay"), reporter,
      trace: { emit: event => events.push(event) } }),
    workflow.borrow("verify").operation("host.verify", async () => {
      await dispatched.opened;
      throw error;
    }),
  ])).catch(reason => reason).finally(() => { returned = true; });
  await dispatched.opened;
  await new Promise(resolve => setImmediate(resolve));
  finishNavigation.open();
  await closing.opened;
  await new Promise(resolve => setImmediate(resolve));
  expect(returned).toBe(false);
  expect(events.some(event => event.kind === "run-end")).toBe(false);
  finishClose.open();
  expect(await pending).toBe(error);
  expect(goto).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(events.filter(event => event.kind === "case-end")).toHaveLength(1);
  expect(events.filter(event => event.kind === "run-end")).toHaveLength(1);
  expect(reporter.emit).not.toHaveBeenCalled();
});

it("waits for a borrowed call's final publication after a sibling fails", async () => {
  const publishing = gate();
  const finishPublication = gate();
  let published = false;
  const emit = vi.fn(async () => {
    publishing.open();
    await finishPublication.opened;
    published = true;
  });
  const error = new Error("host verification failed");
  let returned = false;
  const pending = runWorkflow({ budget: {} }, async workflow => Promise.all([
    runScenario(scenario, { workflow: workflow.borrow("replay"), driver: new FakeDriver({ evidence }), reporter: { emit } }),
    workflow.borrow("verify").operation("host.verify", async () => {
      await publishing.opened;
      throw error;
    }),
  ])).catch(reason => reason).finally(() => { returned = true; });
  await publishing.opened;
  await new Promise(resolve => setImmediate(resolve));
  expect(returned).toBe(false);
  finishPublication.open();
  expect(await pending).toBe(error);
  expect(published).toBe(true);
  expect(emit).toHaveBeenCalledTimes(1);
});

it("rejects a successful callback value when an unfinished borrowed call fails while draining", async () => {
  const finish = gate();
  const planner = vi.fn(async () => scenario);
  const pending = runWorkflow({ budget: {} }, async workflow => {
    void runHarness({ driver: new FakeDriver({ evidence }), reporter,
      context: { provide: async () => { await finish.opened; return { intent: "checkout" }; } },
      planner: { plan: planner }, critic: { judge: async () => ({ passed: true, results: [] }) },
    }, "checkout", { workflow: workflow.borrow("replay") });
    return "premature success";
  });
  const checked = expect(pending).rejects.toThrow("closed");
  await new Promise(resolve => setImmediate(resolve));
  finish.open();
  await checked;
  expect(planner).not.toHaveBeenCalled();
  expect(reporter.emit).not.toHaveBeenCalled();
});

it.each(["operation", "model", "driver"] as const)("observes unfinished %s failures during owner draining", async kind => {
  const finish = gate();
  const error = new Error("late registered failure");
  const fail = async () => { await finish.opened; throw error; };
  const pending = runWorkflow({ budget: {} }, async workflow => {
    const lease = workflow.borrow("host");
    if (kind === "operation") void lease.operation("browser.submit", fail);
    else if (kind === "model") void lease.llm({ id: "model", complete: fail }).complete("verify");
    else {
      const driver = new FakeDriver({ evidence });
      vi.spyOn(driver, "goto").mockImplementation(fail);
      void lease.driver(driver).goto("https://shop");
    }
    return "premature success";
  });
  const checked = expect(pending).rejects.toBe(error);
  await new Promise(resolve => setImmediate(resolve));
  finish.open();
  await checked;
});

it("accepts an already admitted host operation's successful completion during draining", async () => {
  const finish = gate();
  let completed = false;
  const pending = runWorkflow({ budget: {} }, async workflow => {
    void workflow.borrow("host").operation("browser.submit", async () => {
      await finish.opened;
      completed = true;
    });
    return "submitted";
  });
  await new Promise(resolve => setImmediate(resolve));
  finish.open();
  expect(await pending).toMatchObject({ status: "completed", value: "submitted" });
  expect(completed).toBe(true);
});

it("a borrowed run closes its own trace and leaves the stop result to the owner", async () => {
  const events: TraceEvent[] = [];
  const model = judge();
  const outcome = await runWorkflow({ budget: { maxModelCalls: 0 } }, async workflow =>
    runScenario(judged, { workflow: workflow.borrow("verify"), driver: new FakeDriver({ evidence }), llm: model, reporter,
      trace: { emit: event => events.push(event) } }));
  expect(outcome).toMatchObject({ status: "exhausted", participant: "verify", budget: { phase: "judge" } });
  expect(events.map(event => event.kind)).toEqual(["trace", "case-start", "step", "step", "budget-exhausted", "case-end", "run-end"]);
  expect(model.complete).not.toHaveBeenCalled();
  expect(reporter.emit).not.toHaveBeenCalled();
});

it("healthy frozen replay stays model-free under a workflow and keeps its contract", async () => {
  const plain = await runScenario(scenario, { driver: new FakeDriver({ evidence }), reporter });
  const outcome = await runWorkflow({ budget: { maxModelCalls: 0 } }, async workflow =>
    runScenario(scenario, { workflow: workflow.borrow("replay"), driver: new FakeDriver({ evidence }), reporter }));
  expect(outcome).toMatchObject({ status: "completed", modelCalls: 0 });
  if (outcome.status !== "completed") return;
  expect(outcome.value.result.verdict.passed).toBe(true);
  expect(outcome.value.result.verdict.contract).toEqual(plain.result.verdict.contract);
  expect(JSON.stringify(outcome.value.result.verdict.contract)).not.toContain("workflow");
});

it("borrowers cannot replace the owner's limits or signal, reuse a lease, or forge one", async () => {
  await runWorkflow({ budget: { maxModelCalls: 1 } }, async workflow => {
    const lease = workflow.borrow("main");
    const driver = new FakeDriver({ evidence });
    await expect(runScenario(scenario, { workflow: lease, budget: { maxModelCalls: 9 }, driver, reporter })).rejects.toThrow("omit budget and signal");
    await expect(runScenario(scenario, { workflow: workflow.borrow("x"), signal: new AbortController().signal, driver, reporter })).rejects.toThrow("omit budget and signal");
    await runScenario(scenario, { workflow: lease, driver, reporter });
    await expect(runScenario(scenario, { workflow: lease, driver, reporter })).rejects.toThrow("already served");
    await expect(runScenario(scenario, { workflow: { ...lease }, driver, reporter })).rejects.toThrow("lease from runWorkflow");
  });
});

it("an independent budgeted call inside the workflow keeps its own allowance", async () => {
  const outcome = await runWorkflow({ budget: { maxModelCalls: 0 } }, async () =>
    discover("checkout", { driver: new FakeDriver({ evidence }), llm: new ScriptedLlm(['{"action":"done"}', "[]"]), budget: { maxModelCalls: 2 } }));
  expect(outcome).toMatchObject({ status: "completed", modelCalls: 0, participants: [] });
});

it("caller cancellation rejects with its reason rather than an exhaustion outcome", async () => {
  const caller = new AbortController();
  const reason = new Error("host stop");
  await expect(runWorkflow({ budget: { maxModelCalls: 5 }, signal: caller.signal }, async workflow => {
    caller.abort(reason);
    await workflow.borrow("main").operation("browser.click", async () => {});
  })).rejects.toBe(reason);
});

it("preserves caller cancellation while draining a model reply past the deadline", async () => {
  fakeClock();
  const caller = new AbortController();
  const reason = new Error("host stop");
  const dispatched = gate();
  const finish = gate();
  const complete = vi.fn(async () => {
    dispatched.open();
    await finish.opened;
    return "late reply";
  });
  let returned = false;
  const pending = runWorkflow({ budget: { maxModelCalls: 1, timeoutMs: 10 }, signal: caller.signal }, async workflow => {
    await workflow.borrow("main").llm({ id: "ignores-signal", complete }).complete("verify");
  }).catch(error => error).finally(() => { returned = true; });
  await dispatched.opened;
  caller.abort(reason);
  await vi.advanceTimersByTimeAsync(11);
  expect(returned).toBe(false);
  finish.open();
  expect(await pending).toBe(reason);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
