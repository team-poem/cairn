import { describe, expect, it, vi } from "vitest";
import {
  discover, discoverWithTasks, runScenario, runWorkflow,
  type DiscoveryTaskPlan, type LlmClient, type Target,
} from "../src/index.js";
import { StubDriver } from "./support/doubles.js";

const baseUrl = "https://docs.test/";
const ids = ["A", "B", "C"];
const done = { action: "done" };

// Navigation and the document heading change together. Keeping all three buttons visible lets
// the model try the same action twice or try C before B, even with a fresh exact reference.
class Documents extends StubDriver {
  readonly visits: string[] = [];
  private active?: string;
  override async goto(url: string) { this.visits.push(url); this.active = undefined; await super.goto(url); }
  override async snapshot() {
    this.els = ids.map(id => ({ role: "button", name: `Visit ${id}`, ref: `native-${id}` }));
    if (this.active) this.els.push({ role: "heading", name: `Document ${this.active}` });
    return this.els;
  }
  async locateRef(ref: string): Promise<Target> {
    const row = this.els.find(e => e.ref === ref);
    if (!row) throw new Error("missing ref");
    return { role: row.role, text: row.name };
  }
  override async click(target: Target) {
    await super.click(target);
    this.active = target.text?.replace("Visit ", "");
    this.url = baseUrl + this.active;
  }
}

function plan(overrides: Partial<DiscoveryTaskPlan> = {}): DiscoveryTaskPlan {
  return {
    tasks: ids.map(id => ({ id, instruction: `Read document ${id}` })),
    ordered: true, onFailure: "stop",
    match: d => d.action === "click" ? ids.find(id => d.text === `Visit ${id}`) : undefined,
    assess: (id, step, obs) => {
      expect(step).toMatchObject({ kind: "click", target: { text: `Visit ${id}` } });
      expect(obs.url).toBe(baseUrl + id);
      expect(obs.elements).toContainEqual({ role: "heading", name: `Document ${id}` });
      return { route: "completed", verification: "passed" };
    },
    ...overrides,
  };
}

function refFor(prompt: string, id: string): string {
  const ref = prompt.split("\n").find(line => line.includes(`[button] Visit ${id}`) && line.includes('ref="'))
    ?.match(/ref="([^"]+)"/)?.[1];
  if (!ref) throw new Error(`no listed reference for ${id}`);
  return ref;
}
type Reply = string | Record<string, unknown> | ((prompt: string) => Record<string, unknown>);
function model(...replies: Reply[]) {
  const prompts: string[] = [], assertionPrompts: string[] = [];
  const llm: LlmClient = { id: "task-fixture", async complete(prompt) {
    if (prompt.includes("Propose the verification assertions.")) { assertionPrompts.push(prompt); return "[]"; }
    const reply = replies[prompts.length] ?? done;
    prompts.push(prompt);
    return JSON.stringify(typeof reply === "string" ? { action: "click", ref: refFor(prompt, reply) }
      : typeof reply === "function" ? reply(prompt) : reply);
  } };
  return { llm, prompts, assertionPrompts };
}
const oneTask = () => plan().tasks.slice(0, 1);

describe("discoverWithTasks", () => {
  it("keeps the policy's known goal URL when the driver omits it, without presenting it as task evidence", async () => {
    const driver = new Documents(baseUrl), observe = driver.observe.bind(driver);
    driver.observe = async () => {
      const evidence = await observe();
      delete evidence.execution.finalUrl;
      return evidence;
    };
    const m = model("A"), stop = vi.fn((_steps, ctx) => ctx.url === baseUrl);
    const { progress, scenario } = await discoverWithTasks("stop at the goal", {
      driver, baseUrl, llm: m.llm, taskPlan: plan(), pageGuidance: () => undefined,
      policy: { vet: () => ({ ok: true }), stop },
    });
    expect(stop.mock.calls[0]?.[1].url).toBe(baseUrl);
    expect(progress).toMatchObject({ reason: "policy-stop", completed: [], remaining: ids });
    expect(scenario.truncated).toBe(true);
    expect(m.prompts).toHaveLength(0);
    expect(driver.clicked).toEqual([]);
  });

  it.each([1, 3])("isolates measured task evidence from a policy editing its context (maxSteps %i)", async maxSteps => {
    const driver = new Documents(baseUrl);
    const realUrl = baseUrl + "A?denied=1";
    const click = driver.click.bind(driver);
    driver.click = async target => { await click(target); driver.url = realUrl; };
    const assess = vi.fn<DiscoveryTaskPlan["assess"]>((_id, _step, observation) => {
      const pass = observation.url === baseUrl + "A" || observation.elements.some(e => e.name === "Approved");
      return { route: pass ? "completed" : "unavailable", verification: pass ? "passed" : "failed" };
    });
    const { progress, scenario } = await discoverWithTasks("read A", {
      driver, baseUrl, maxSteps, llm: model("A").llm, taskPlan: plan({ tasks: oneTask(), assess }),
      policy: { vet: () => ({ ok: true }), observe(ctx) {
        if (ctx.url?.includes("?")) ctx.url = ctx.url.split("?")[0];
        const row = ctx.elements.find(e => e.role === "heading");
        if (row) row.name = "Approved";
      } },
    });
    expect(assess.mock.calls[0]?.[2].url).toBe(realUrl);
    expect(progress.tasks).toEqual([{ id: "A", route: "unavailable", verification: "failed" }]);
    expect(scenario.truncated).toBe(true);
  });

  it("recaptures rows if the scroll policy reads a newer URL before task assessment", async () => {
    const driver = new Documents(baseUrl), observe = driver.observe.bind(driver);
    let postReads = 0;
    driver.observe = async () => {
      if (driver.clicked.length && ++postReads === 3) driver.url = baseUrl + "redirect";
      return observe();
    };
    const assess = vi.fn<DiscoveryTaskPlan["assess"]>((_id, _step, ctx) =>
      ctx.url === baseUrl + "A" ? { route: "completed", verification: "passed" } : { route: "unavailable", verification: "failed" });
    const { scenario, progress } = await discoverWithTasks("read A", {
      driver, baseUrl, maxSteps: 4, llm: model("A").llm, taskPlan: plan({ tasks: oneTask(), assess }),
      policy: { needsScrollState: true, vet: () => ({ ok: true }) },
    });
    expect(assess.mock.calls.map(call => call[2].url)).toEqual([baseUrl + "redirect"]);
    expect(driver.clicked).toEqual(["Visit A"]);
    expect(progress.reason).toBe("task-failed");
    expect(scenario.truncated).toBe(true);
  });

  it.each([false, true])("keeps the model's original observation when the row owner reuses objects (perceive: %s)", async usePerception => {
    const driver = new StubDriver();
    const owned = [{ role: "button", name: "Continue" }, { role: "checkbox", name: "Ready", checked: false }];
    driver.els = usePerception ? structuredClone(owned) : owned;
    const m = model(() => {
      owned[1]!.checked = true;
      return { action: "click", role: "button", text: "Continue" };
    });
    const { progress } = await discoverWithTasks("Continue if already ready", {
      driver, llm: m.llm, maxSteps: 1, ...(usePerception && { perceive: () => owned }),
      taskPlan: plan({ tasks: oneTask(), match: (_decision, ctx) =>
        ctx.elements.some(e => e.name === "Ready" && e.checked) ? "A" : undefined }),
    });
    expect(progress.remaining).toEqual(["A"]);
    expect(driver.clicked).toEqual([]);
  });

  it("does not start a task run with an already aborted signal, even without a budget", async () => {
    const driver = new Documents(), caller = new AbortController(), reason = new Error("already stopped");
    const settle = vi.spyOn(driver, "settle"), observe = vi.spyOn(driver, "observe");
    caller.abort(reason);
    await expect(discoverWithTasks("read A", { driver, baseUrl, signal: caller.signal, llm: model("A").llm,
      taskPlan: plan() })).rejects.toBe(reason);
    expect(driver.visits).toEqual([]);
    expect(settle).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it("continues after A with a new observation, rejects the old ref, and leaves a replayable path", async () => {
    const driver = new Documents();
    let expired = "";
    const m = model("A", p => { expired = refFor(p, "B"); return done; },
      p => { expect(refFor(p, "B")).not.toBe(expired); return { action: "click", ref: expired }; }, "B", "C");
    const result = await discoverWithTasks("check each document", { driver, baseUrl, llm: m.llm, taskPlan: plan() });
    expect(m.prompts[2]).toContain("Read document B");
    expect(driver.clicked).toEqual(["Visit A", "Visit B", "Visit C"]);
    expect(m.prompts).toHaveLength(5);
    expect(result.progress).toMatchObject({ reason: "tasks-complete", modelDoneCount: 1, completed: ids, remaining: [] });
    expect(result.scenario.truncated).not.toBe(true);
    expect(result.scenario).not.toHaveProperty("progress");
    expect(JSON.stringify(result.scenario)).not.toContain("Read document B");
    const replay = new Documents();
    const { result: replayed } = await runScenario(result.scenario, { driver: replay, reporter: { async emit() {} } });
    expect(replayed.verdict.passed).toBe(true);
    expect(replayed.usage?.llmCalls).toBe(0);
    expect(replay.clicked).toEqual(driver.clicked);
  });

  it("vetoes out-of-order and already executed tasks before the driver, with fresh progress per call", async () => {
    const taskPlan = plan();
    for (let i = 0; i < 2; i++) {
      const driver = new Documents();
      const { progress } = await discoverWithTasks("read in order", {
        baseUrl, driver, llm: model("B", "A", "A", "C", "B", "C").llm, taskPlan,
      });
      expect(driver.clicked).toEqual(["Visit A", "Visit B", "Visit C"]);
      expect(progress.completed).toEqual(ids);
    }
  });

  it("discards a premature done's assertion instead of treating it as proof of the remaining task", async () => {
    const claim = { kind: "expect", criterion: "Document B has already been checked" };
    const early = { action: "done", assertions: [claim] };
    // This proposal is valid when a done is accepted; an unrelated grounding rejection cannot
    // make the negative assertion below pass.
    const legacy = await discover("read A", { driver: new Documents(), baseUrl, llm: model("A", early).llm, semanticChecks: true });
    expect(legacy.assertions).toContainEqual(expect.objectContaining(claim));

    const driver = new Documents(), m = model("A", early, "B");
    const { progress, scenario } = await discoverWithTasks("read A and B", {
      driver, baseUrl, llm: m.llm, semanticChecks: true, taskPlan: plan({ tasks: plan().tasks.slice(0, 2) }),
    });
    expect(driver.clicked).toEqual(["Visit A", "Visit B"]);
    expect(progress).toMatchObject({ modelDoneCount: 1, completed: ["A", "B"], remaining: [] });
    expect(m.prompts[2]).toContain("Read document B");
    expect(scenario.assertions).not.toContainEqual(expect.objectContaining(claim));
  });

  it("counts early done against both the retry allowance and the run's model usage", async () => {
    const driver = new Documents(), m = model(done, done, done, "A");
    const result = await runWorkflow({ budget: { maxModelCalls: 10 } }, workflow =>
      discoverWithTasks("read documents", {
        workflow: workflow.borrow("documents"), driver, baseUrl, llm: m.llm, taskPlan: plan({ maxEarlyDone: 2 }),
      }));
    if (result.status !== "completed") throw new Error(result.status);
    expect(result.value.progress).toMatchObject({ reason: "early-done-limit", modelDoneCount: 3, completed: [], remaining: ids });
    expect(result.value.scenario.truncated).toBe(true);
    expect(driver.clicked).toEqual([]);
    expect(m.prompts).toHaveLength(3);
    expect(result.modelCalls).toBe(3 + m.assertionPrompts.length);
  });

  it("retains a failed verification while continuing independent targets; no failure triggers a revisit", async () => {
    for (const onFailure of ["stop", "continue"] as const) {
      const driver = new Documents(), assess = vi.fn<DiscoveryTaskPlan["assess"]>(id =>
        ({ route: "completed", verification: id === "A" ? "failed" : "passed" }));
      const { scenario, progress } = await discoverWithTasks("check documents", {
        baseUrl, driver, llm: model("A", "B", "C").llm, taskPlan: plan({ ordered: false, onFailure, assess }),
      });
      const visited = onFailure === "stop" ? ["A"] : ids;
      expect(assess.mock.calls.map(([id]) => id)).toEqual(visited);
      expect(driver.clicked).toEqual(visited.map(id => `Visit ${id}`));
      expect(progress).toMatchObject({ reason: "task-failed", completed: visited, remaining: onFailure === "stop" ? ["B", "C"] : [] });
      expect(progress.tasks[0]).toMatchObject({ id: "A", route: "completed", verification: "failed" });
      expect(scenario.truncated).toBe(true);
    }
  });

  it("does not spend a decision or navigate again to resolve unknown verification", async () => {
    const driver = new Documents(), m = model("A", "A");
    const { scenario, progress } = await discoverWithTasks("check A", { driver, baseUrl, llm: m.llm,
      taskPlan: plan({ tasks: oneTask(), assess: () => ({ route: "completed", verification: "unknown" }) }) });
    expect(progress).toMatchObject({ reason: "tasks-complete", modelDoneCount: 0,
      tasks: [{ id: "A", route: "completed", verification: "unknown" }] });
    expect(scenario.truncated).not.toBe(true);
    expect(m.prompts).toHaveLength(1);
    expect(driver.clicked).toEqual(["Visit A"]);
  });

  it("keeps an unavailable target in the report and does not dispatch it again", async () => {
    const driver = new Documents();
    const { scenario, progress } = await discoverWithTasks("check A", { driver, baseUrl, llm: model("A", "A").llm,
      taskPlan: plan({ assess: () => ({ route: "unavailable", verification: "unknown" }) }) });
    expect(progress).toMatchObject({ reason: "task-unavailable", completed: [] });
    expect(progress.tasks[0]).toMatchObject({ id: "A", route: "unavailable" });
    expect(scenario.truncated).toBe(true);
    expect(driver.clicked).toEqual(["Visit A"]);
  });

  it("does not use a host match to authorize an invented navigation URL", async () => {
    const driver = new Documents();
    const { progress } = await discoverWithTasks("read A", { driver, baseUrl,
      llm: model({ action: "goto", url: "https://invented.test/" }, "A").llm,
      taskPlan: plan({ tasks: oneTask(), match: () => "A" }) });
    expect(driver.visits).toEqual([baseUrl]);
    expect(driver.clicked).toEqual(["Visit A"]);
    expect(progress.completed).toEqual(["A"]);
  });

  it("does not replay input after the driver received a click but could not confirm dispatch", async () => {
    const driver = new Documents(), assess = vi.fn(plan().assess);
    const click = driver.click.bind(driver);
    driver.click = async target => { await click(target); throw new Error("driver timed out after sending input"); };
    const { scenario, progress } = await discoverWithTasks("check A", { driver, baseUrl, llm: model("A", "A").llm,
      taskPlan: plan({ assess }) });
    expect(driver.clicked).toEqual(["Visit A"]);
    expect(scenario.truncated).toBe(true);
    expect(scenario.steps.map(s => s.kind)).toEqual(["goto"]);
    expect(assess).not.toHaveBeenCalled();
    expect(progress).toMatchObject({ reason: "dispatch-uncertain", completed: [] });
    expect(progress.tasks[0]).toMatchObject({ id: "A", route: "unconfirmed", verification: "unknown" });
  });

  it("stops at the existing decision cap and assesses the last dispatched action", async () => {
    const driver = new Documents(), m = model(done, "A", "B");
    const { progress, scenario } = await discoverWithTasks("check documents", {
      driver, baseUrl, llm: m.llm, maxSteps: 2, taskPlan: plan(),
    });
    expect(driver.clicked).toEqual(["Visit A"]);
    expect(m.prompts).toHaveLength(2);
    expect(progress).toMatchObject({ reason: "step-limit", completed: ["A"], remaining: ["B", "C"] });
    expect(scenario.truncated).toBe(true);
  });

  it("a continuation cannot spend a model call past the shared limit", async () => {
    const driver = new Documents(), m = model("A", done, "B");
    await expect(discoverWithTasks("read A and B", { driver, baseUrl, llm: m.llm, taskPlan: plan(),
      budget: { maxModelCalls: 2 } })).rejects.toMatchObject({ budget: { modelCalls: 2 } });
    expect(m.prompts).toHaveLength(2);
    expect(driver.clicked).toEqual(["Visit A"]);
  });

  it("rejects a continued action if time expires during locator enrichment", async () => {
    const driver = new Documents(), locate = driver.locateRef.bind(driver);
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    driver.locateRef = async ref => {
      const target = await locate(ref);
      if (target.text === "Visit B") now = 60_001;
      return target;
    };
    try {
      await expect(discoverWithTasks("read documents", { driver, baseUrl, taskPlan: plan(),
        llm: model("A", done, "B").llm, budget: { timeoutMs: 60_000 } }))
        .rejects.toMatchObject({ budget: { limit: "time" } });
      expect(driver.clicked).toEqual(["Visit A"]);
    } finally { clock.mockRestore(); }
  });

  it("keeps a safety veto in force after a premature done", async () => {
    const driver = new Documents(), assessed = vi.fn(plan().assess);
    const { progress, scenario } = await discoverWithTasks("read documents", { driver, baseUrl,
      taskPlan: plan({ assess: assessed }), llm: model("A", done, "B", "B", "B").llm,
      policy: { vet: decision => decision.text === "Visit B" ? { ok: false, reason: "restricted" } : { ok: true } },
    });
    expect(driver.clicked).toEqual(["Visit A"]);
    expect(assessed.mock.calls.map(([id]) => id)).toEqual(["A"]);
    expect(progress).toMatchObject({ completed: ["A"], remaining: ["B", "C"] });
    expect(scenario.truncated).toBe(true);
  });

  it("discards a continued decision if its URL changes after the host authorized it", async () => {
    const driver = new Documents(), locate = driver.locateRef.bind(driver), original = plan();
    let first = true;
    const admittedOn: (string | undefined)[] = [];
    driver.locateRef = async ref => {
      const target = await locate(ref);
      if (target.text === "Visit B" && first) { first = false; driver.url = baseUrl + "changed"; }
      return target;
    };
    const m = model("A", done, "B", "B");
    const { progress } = await discoverWithTasks("read A and B", { driver, baseUrl, llm: m.llm,
      taskPlan: plan({ tasks: original.tasks.slice(0, 2), match: (d, ctx) => {
        if (d.text === "Visit B") admittedOn.push(ctx.url);
        return original.match(d, ctx);
      } }) });
    expect(driver.clicked).toEqual(["Visit A", "Visit B"]);
    // On A, lookup invalidated the first approval. Only the retry was approved both times.
    expect(admittedOn).toEqual([baseUrl + "A", baseUrl + "changed", baseUrl + "changed"]);
    expect(m.prompts).toHaveLength(4);
    expect(progress.completed).toEqual(["A", "B"]);
  });

  describe.each(["snapshot", "perceive"] as const)("navigation during %s", when => {
    it.each([false, true])("never assesses rows from a mixed observation (at cap: %s)", async capped => {
      const driver = new Documents();
      const moved = baseUrl + "unrelated";
      const changePage = async () => {
        if (driver.url === baseUrl + "A") await driver.goto(moved);
      };
      const snapshot = driver.snapshot.bind(driver);
      driver.snapshot = async () => {
        if (when === "snapshot") await changePage();
        return snapshot();
      };
      const assess = vi.fn<DiscoveryTaskPlan["assess"]>((_id, _step, ctx) => {
        expect(ctx.url).toBe(moved);
        expect(ctx.elements.some(e => e.name === "Document A")).toBe(false);
        return { route: "unavailable", verification: "unknown" };
      });
      const { progress, scenario } = await discoverWithTasks("open A", { driver, baseUrl, llm: model("A").llm,
        maxSteps: capped ? 1 : 4, taskPlan: plan({ tasks: oneTask(), assess }),
        perceive: async rows => { if (when === "perceive") await changePage(); return rows; },
      });
      expect(assess).toHaveBeenCalledTimes(capped ? 0 : 1);
      expect(progress).toMatchObject({ reason: capped ? "step-limit" : "task-unavailable", completed: [], remaining: ["A"],
        tasks: [{ id: "A", route: capped ? "unconfirmed" : "unavailable", verification: "unknown" }] });
      expect(driver.clicked).toEqual(["Visit A"]);
      expect(scenario.truncated).toBe(true);
    });
  });

  it("a failing host match rejects without sending the host's error back to the model", async () => {
    const driver = new Documents(), m = model("A", "A"), error = new Error("private host diagnostic");
    await expect(discoverWithTasks("read A", { driver, baseUrl, llm: m.llm,
      taskPlan: plan({ match: () => { throw error; } }) })).rejects.toBe(error);
    expect(m.prompts).toHaveLength(1);
    expect(m.assertionPrompts).toEqual([]);
    expect(driver.clicked).toEqual([]);
  });

  it.each(["perception", "transport"] as const)("propagates a %s error during the last task check without a new decision", async kind => {
    const driver = new Documents(), m = model("A", "A");
    const error = Object.assign(new Error("private diagnostic"), kind === "transport" ? { kind } : {});
    if (kind === "transport") Object.assign(driver, { snapshotForTask: async () => { throw error; } });
    let captures = 0;
    await expect(discoverWithTasks("read A", { driver, baseUrl, llm: m.llm, taskPlan: plan(), perceive: rows => {
      if (++captures === 2 && kind === "perception") throw error;
      return rows;
    } })).rejects.toBe(error);
    expect(m.prompts).toHaveLength(1);
    expect(driver.clicked).toEqual([]);
  });

  it("a legacy driver admits only an exact observed target, not an invented match or ordinal", async () => {
    const driver = new StubDriver();
    driver.els = [{ role: "button", name: "Visit A" }];
    const click = (text: string, extra: object = {}) => ({ action: "click", role: "button", text, ...extra });
    const m = model(click("Visit"), click("Visit A", { role: "heading" }), click("Visit A", { nth: 9 }), click("Visit A"));
    const { progress } = await discoverWithTasks("read A", { driver, baseUrl, llm: m.llm,
      taskPlan: plan({ tasks: oneTask(), match: () => "A", assess: () => ({ route: "completed", verification: "unknown" }) }),
    });
    expect(m.prompts).toHaveLength(4);
    expect(driver.clicked).toEqual(["Visit A"]);
    expect(progress.completed).toEqual(["A"]);
  });

  it.each(["hide", "reorder"] as const)("a legacy driver does not dispatch a duplicate after perception can %s rows", async mode => {
    const driver = new StubDriver();
    driver.els = [
      { role: "button", name: "Open", value: "first" }, { role: "button", name: "Open", value: "second" },
      { role: "button", name: "Unique" },
    ];
    const m = model({ action: "click", role: "button", text: "Open", ...(mode === "reorder" && { nth: 0 }) },
      { action: "click", role: "button", text: "Unique" });
    const match = vi.fn<DiscoveryTaskPlan["match"]>(() => "A");
    await discoverWithTasks("open A", { driver, baseUrl, llm: m.llm, taskPlan: plan({
      tasks: oneTask(), match, assess: () => ({ route: "completed", verification: "unknown" }),
    }), perceive: rows => mode === "hide" ? rows.filter(row => row.value !== "first") : rows.reverse() });
    expect(driver.clicked).toEqual(["Unique"]);
    expect(match.mock.calls.map(([decision]) => decision.text)).toEqual(["Unique", "Unique"]);
  });

  it("a trusted policy can stop the run but cannot mark its unvisited tasks complete", async () => {
    const driver = new Documents();
    const { scenario, progress } = await discoverWithTasks("read documents", { driver, baseUrl, llm: model("A", "B").llm,
      policy: { vet: () => ({ ok: true }), stop: () => driver.clicked.length === 1 }, taskPlan: plan() });
    expect(driver.clicked).toEqual(["Visit A"]);
    expect(progress).toMatchObject({ reason: "policy-stop", completed: ["A"], remaining: ["B", "C"] });
    expect(scenario.truncated).toBe(true);
  });

  it("route completion cannot waive a policy's terminal no-progress diagnosis", async () => {
    const driver = new Documents();
    const { scenario, progress } = await discoverWithTasks("read A", { driver, baseUrl, llm: model("A").llm,
      taskPlan: plan({ tasks: oneTask() }), policy: { vet: () => ({ ok: true }),
        incomplete: () => driver.clicked.length ? {
          halt: true, diagnostic: { code: "no-progress", repeatedTransitions: 2, recoveryTurns: 0 },
        } : undefined },
    });
    expect(progress.completed).toEqual(["A"]);
    expect(scenario).toMatchObject({ truncated: true, truncationReason: "no-progress" });
    expect(driver.clicked).toEqual(["Visit A"]);
  });

  it("a cancellation during the first continuation decision prevents further input", async () => {
    const driver = new Documents(), caller = new AbortController(), stopped = new Error("stop");
    const m = model("A", done, p => { caller.abort(stopped); return { action: "click", ref: refFor(p, "B") }; });
    await expect(discoverWithTasks("read documents", { driver, baseUrl, signal: caller.signal, llm: m.llm,
      taskPlan: plan() })).rejects.toBe(stopped);
    expect(driver.clicked).toEqual(["Visit A"]);
  });

  it("ordinary discovery still accepts done or returns an existing policy's incomplete recording", async () => {
    for (const incomplete of [false, true]) {
      const driver = new Documents(), m = model("A", done, "B");
      const scenario = await discover("read documents", { driver, baseUrl, llm: m.llm, ...(incomplete && {
        policy: { vet: () => ({ ok: true }), incomplete: () => ({
          halt: false, diagnostic: { code: "no-progress", repeatedTransitions: 1, recoveryTurns: 1 },
        }) },
      }) });
      expect(driver.clicked).toEqual(["Visit A"]);
      expect(m.prompts).toHaveLength(2);
      expect(scenario.truncated === true).toBe(incomplete);
      expect(scenario).not.toHaveProperty("progress");
    }
  });
});
