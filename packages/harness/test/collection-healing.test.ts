import { describe, expect, it, vi } from "vitest";
import { SelfHealingDriver } from "../src/adapters/drivers/self-heal.js";
import { createTargetChoiceRepair } from "../src/adapters/drivers/target-choice.js";
import { AssertionCritic } from "../src/adapters/critics/assertion.js";
import { InlineContextProvider } from "../src/adapters/context/inline.js";
import { StaticPlanner } from "../src/adapters/planners/static.js";
import { CollectionSelectionError } from "../src/core/collection.js";
import { stepError } from "../src/core/errors.js";
import { runHarness } from "../src/core/pipeline.js";
import { LlmStepHealer } from "../src/core/step-heal.js";
import type { Driver, LlmClient } from "../src/core/ports.js";
import type { CollectionObservation, CollectionTarget, Scenario, Step, Target } from "../src/core/types.js";
import { runScenario } from "../src/run.js";
import { StubDriver } from "./support/doubles.js";

const reporter = { emit: async () => {} };
const declaration = (): CollectionTarget => ({
  root: { role: "list", name: "Results" }, itemRole: "listitem",
  target: { role: "link", name: "Open" }, order: "dom", index: 0,
});
const collectionStep = (over: Partial<Extract<Step, { kind: "click" }>> = {}): Step => ({
  kind: "click", target: { collection: declaration() }, intent: "Open the current first result", ...over,
});
const scenario = (step: Step = collectionStep()): Scenario => ({
  name: "Open first result", steps: [step], assertions: [{ kind: "navigated", to: "app/start" }],
});
const observation = (): CollectionObservation => ({
  order: "dom", complete: true, conditions: [],
  items: [{ position: 0, target: { role: "link", name: "Open", ref: "current-first" } }],
});
function model(): LlmClient & { complete: ReturnType<typeof vi.fn> } {
  return { id: "unused", complete: vi.fn(async () => '{"action":"done"}') };
}

class CollectionDriver extends StubDriver {
  readonly refs: Array<string | undefined> = [];
  readonly observeCollection = vi.fn(async (_selection: CollectionTarget) => observation());
  override async click(target: Target, ref?: string): Promise<void> {
    this.refs.push(ref);
    await super.click(target);
  }
}

function harness(input: Scenario, driver: Driver) {
  return { context: new InlineContextProvider(), planner: new StaticPlanner(input), driver,
    critic: new AssertionCritic(), reporter };
}

describe("collection repair boundaries", () => {
  it("forwards collection observation only when the inner driver supports it", async () => {
    const llm = model();
    const inner = new CollectionDriver();
    const wrapped = new SelfHealingDriver(inner, llm);
    const selection = declaration();
    expect(await wrapped.observeCollection!(selection)).toEqual(observation());
    expect(inner.observeCollection).toHaveBeenCalledWith(selection);
    expect(new SelfHealingDriver(new StubDriver(), llm).observeCollection).toBeUndefined();
  });

  it("does not manufacture collection support from a malformed inner capability", async () => {
    const inner = Object.assign(new StubDriver(), { observeCollection: 42 }) as unknown as Driver;
    const wrapped = new SelfHealingDriver(inner, model());
    expect(wrapped.observeCollection).toBeUndefined();
    const result = await runHarness(harness(scenario(), wrapped), "Open first result");
    expect(result.verdict.failure).toBe("environment");
    expect(result.evidence.execution.actions[0]).toMatchObject({ errorKind: "handler" });
    expect(inner).toMatchObject({ clicked: [] });
  });

  it.each(["click", "doubleClick", "hover", "type", "select"] as const)(
    "does not repair a directly dispatched collection %s failure", async kind => {
      const inner = new CollectionDriver();
      const action = vi.spyOn(inner, kind).mockRejectedValue(stepError("resolution", "member disappeared"));
      const snapshot = vi.spyOn(inner, "snapshot");
      const llm = model();
      const wrapped = new SelfHealingDriver(inner, llm);
      const target = { collection: declaration() };
      const attempt = kind === "type" || kind === "select" ? wrapped[kind](target, "value") : wrapped[kind](target);
      await expect(attempt).rejects.toThrow("member disappeared");
      expect(action).toHaveBeenCalledTimes(1);
      expect(snapshot).not.toHaveBeenCalled();
      expect(llm.complete).not.toHaveBeenCalled();
      expect(wrapped.heals).toEqual([]);
    },
  );

  it("rejects malformed declarations before a direct wrapper dispatch", async () => {
    const inner = new CollectionDriver();
    const action = vi.spyOn(inner, "click");
    const llm = model();
    const wrapped = new SelfHealingDriver(inner, llm);
    await expect(wrapped.click({ collection: undefined })).rejects.toBeInstanceOf(CollectionSelectionError);
    expect(action).not.toHaveBeenCalled();
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("refuses target-choice before reading context or invoking its selector", () => {
    const context = vi.fn(() => ({ intent: "Open first", stepRef: 0 }));
    const select = vi.fn(async () => { throw new Error("collection repair must not invoke the selector"); });
    const repair = createTargetChoiceRepair({ context, selector: { select }, minConfidence: 0.8 });
    expect(() => repair.prepare({ collection: declaration() })).toThrow("explicit collection position");
    expect(() => repair.prepare({ collection: undefined })).toThrow("explicit collection position");
    expect(context).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it("does not ask the default step healer to substitute a collection action", async () => {
    const llm = model();
    const driver = new CollectionDriver();
    const snapshot = vi.spyOn(driver, "snapshot");
    const healer = new LlmStepHealer(llm);
    expect(await healer.heal(collectionStep(), 0, driver)).toBeNull();
    expect(snapshot).not.toHaveBeenCalled();
    expect(llm.complete).not.toHaveBeenCalled();
    expect(healer.heals).toEqual([]);
  });

  it("does not invoke an injected step healer after a positional post-condition fails", async () => {
    const input = scenario(collectionStep({ expect: { url: "app/destination" } }));
    const driver = new CollectionDriver();
    const heal = vi.fn(async () => null);
    const result = await runHarness(harness(input, driver), input.name, { stepHealer: { heal }, expectTimeoutMs: 0 });
    expect(driver.refs).toEqual(["current-first"]);
    expect(result.evidence.execution.actions[0]).toMatchObject({ ok: false, errorKind: "post-condition" });
    expect(heal).not.toHaveBeenCalled();
  });

  it("executes a collection action even when its state-like expect already holds", async () => {
    const input = scenario(collectionStep({ expect: { url: "app/start" } }));
    const driver = new CollectionDriver();
    const result = await runHarness(harness(input, driver), input.name);
    expect(driver.refs).toEqual(["current-first"]);
    expect(result.evidence.execution.actions[0]).toMatchObject({ ok: true });
    expect(result.evidence.execution.actions[0]?.skipped).toBeUndefined();
  });

  it("keeps legacy state-like expect skipping unchanged", async () => {
    const input = scenario({ kind: "click", target: { text: "Open" }, expect: { url: "app/start" } });
    const driver = new CollectionDriver();
    const result = await runHarness(harness(input, driver), input.name);
    expect(driver.refs).toEqual([]);
    expect(driver.observeCollection).not.toHaveBeenCalled();
    expect(result.evidence.execution.actions[0]).toMatchObject({ ok: true, skipped: true });
  });

  it("keeps legacy default step-heal model admission unchanged", async () => {
    const llm = model();
    const driver = new StubDriver();
    const healer = new LlmStepHealer(llm);
    expect(await healer.heal({ kind: "click", target: { text: "Open" }, intent: "Open" }, 0, driver)).toBeNull();
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it("does not rediscover a positional scenario whose original goal fails", async () => {
    const input = { ...scenario(), assertions: [{ kind: "navigated" as const, to: "app/destination" }] };
    const driver = new CollectionDriver();
    const llm = model();
    const output = await runScenario(input, { driver, llm, reporter, heal: true, budget: { maxModelCalls: 0 } });
    expect(driver.refs).toEqual(["current-first"]);
    expect(output.result.verdict.passed).toBe(false);
    expect(output.result.verdict.failure).not.toBe("budget");
    expect(output.result.verdict.detail).toContain("explicit collection positions");
    expect(output.result.verdict.results[0]?.assertion).toEqual(input.assertions[0]);
    expect(llm.complete).not.toHaveBeenCalled();
    expect(output.heals).toEqual([]);
    expect(output.stepHeals).toEqual([]);
    expect(output.healedScenario).toBeUndefined();
  });

  it("does not invoke any repair layer for stale exact collection references", async () => {
    const driver = new CollectionDriver();
    const action = vi.spyOn(driver, "click").mockRejectedValue(stepError("resolution", "stale collection ref"));
    const llm = model();
    const output = await runScenario(scenario(), { driver, llm, reporter, heal: true, budget: { maxModelCalls: 0 } });
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith({ text: "Open", role: "link" }, "current-first");
    expect(output.result.verdict.passed).toBe(false);
    expect(output.result.evidence.execution.actions[0]?.error).toContain("stale collection ref");
    expect(llm.complete).not.toHaveBeenCalled();
    expect(output.healedScenario).toBeUndefined();
  });

  it("rejects malformed scenario data before navigation and model calls", async () => {
    const driver = new CollectionDriver();
    const goto = vi.spyOn(driver, "goto");
    const llm = model();
    const input = scenario(collectionStep({ target: { collection: { ...declaration(), index: -1 } } }));
    input.steps.unshift({ kind: "goto", url: "https://app/start" });
    await expect(runScenario(input, { driver, llm, reporter, heal: true })).rejects.toBeInstanceOf(CollectionSelectionError);
    expect(goto).not.toHaveBeenCalled();
    expect(driver.observeCollection).not.toHaveBeenCalled();
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it.each(["runHarness", "runScenario"] as const)("%s snapshots the nested declaration before browser work", async entry => {
    const selection = declaration();
    const input = scenario(collectionStep({ target: { collection: selection } }));
    input.steps.unshift({ kind: "goto", url: "https://app/start" });
    const driver = new CollectionDriver();
    vi.spyOn(driver, "goto").mockImplementation(async () => { selection.index = 4; selection.root.name = "Changed"; });
    if (entry === "runScenario") await runScenario(input, { driver, reporter });
    else await runHarness(harness(input, driver), input.name);
    expect(driver.observeCollection).toHaveBeenCalledWith(declaration());
    expect(driver.refs).toEqual(["current-first"]);
    expect(selection).toMatchObject({ index: 4, root: { name: "Changed" } });
  });

  it.each(["runHarness", "runScenario"] as const)("%s honors standalone cancellation during collection observation", async entry => {
    const driver = new CollectionDriver();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    driver.observeCollection.mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve; started(); });
      return observation();
    });
    const caller = new AbortController();
    const reason = new Error("cancel positional observation");
    const input = scenario();
    const pending = entry === "runScenario"
      ? runScenario(input, { driver, reporter, signal: caller.signal })
      : runHarness(harness(input, driver), input.name, { signal: caller.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    await ready;
    caller.abort(reason);
    release();
    await rejected;
    expect(driver.refs).toEqual([]);
  });

  it("does not type after standalone cancellation during scoped-secret origin observation", async () => {
    const driver = new CollectionDriver();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const observed = await driver.observe();
    vi.spyOn(driver, "observe").mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve; started(); });
      return observed;
    });
    const type = vi.spyOn(driver, "type");
    const input = scenario({ kind: "type", target: { collection: declaration() }, text: "{token}" });
    const caller = new AbortController();
    const reason = new Error("cancel secret preparation");
    const pending = runHarness(harness(input, driver), input.name, {
      signal: caller.signal, secrets: { token: { value: "private", origin: "https://app" } },
    });
    const rejected = expect(pending).rejects.toBe(reason);
    await ready;
    caller.abort(reason);
    release();
    await rejected;
    expect(type).not.toHaveBeenCalled();
  });
});
