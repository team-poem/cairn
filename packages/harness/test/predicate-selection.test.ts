import { afterEach, describe, expect, it, vi } from "vitest";
import { runScenario } from "../src/run.js";
import { CollectionSelectionError, resolveCollectionTarget, SelectionNotDispatchedError } from "../src/core/collection.js";
import { identifyScenario, compareContracts } from "../src/core/contract.js";
import { selectedItemEquals, SelectedItemEvidenceSession } from "../src/core/selected-item-evidence.js";
import { scoreTarget } from "../src/core/freeze.js";
import type { SelectedItemBinding, SelectedItemKey, ResourceKeyObservation } from "../src/core/selected-item-evidence.js";
import type { CollectionObservation, CollectionTarget, Scenario, Step, Target } from "../src/core/types.js";
import { StubDriver } from "./support/doubles.js";
import { runWorkflow, type WorkflowLease } from "../src/core/budget.js";
import { rediscoveryEligibility as nodeEligibility } from "../src/index.js";
import { rediscoveryEligibility as browserEligibility } from "../src/browser.js";

const identity: SelectedItemKey = { kind: "attribute", scope: "item", attribute: "data-resource-id" };
function choice(name: string, bound = false): Step & { kind: "click" } {
  return { kind: "click", target: { collection: {
    root: { role: "list", name }, itemRole: "listitem", target: { role: "button", name: bound ? "Select" : "Add" },
    order: "dom", expectedCount: 2, choice: { version: 1, cardinality: 1, policy: "first-dom", identity,
      where: [{ kind: "attribute-equals", scope: "item", attribute: bound ? "data-resource-id" : "data-available",
        value: bound ? { bindingId: "added-item" } : "true" }], maxReselections: bound ? 0 : 1 },
  } } };
}
function fixture() {
  const steps: Step[] = [choice("Catalog"), choice("Cart", true)];
  const binding: SelectedItemBinding = { version: 1, id: "added-item", phase: "replay", relation: "resource-key-equals",
    source: { after: [steps[0]!], key: identity }, destination: { after: steps,
      key: { kind: "attribute", selector: "#review", attribute: "data-resource-id" } } };
  const scenario: Scenario = { name: "choose an eligible item and review that item", steps, assertions: [
    { kind: "custom", name: "selected", params: binding as unknown as Record<string, unknown> },
  ] };
  return { scenario, binding };
}
const reporter = { emit: async () => {} };
const custom = { selected: selectedItemEquals };

class ChoiceDriver extends StubDriver {
  available = [false, true];
  readonly keys = ["private-A", "private-B"];
  readonly mutations: string[] = [];
  readonly observations: CollectionTarget[] = [];
  readonly refs = new Map<string, { key: string; source: boolean }>();
  attempts = 0;
  selected?: string;
  added?: string;
  destination?: string;
  complete = true;
  beforeObserve?: () => void | Promise<void>;
  beforeDispatch?: (ref: string) => void | Promise<void>;
  afterDispatch?: () => void | Promise<void>;

  async observeCollection(selection: CollectionTarget): Promise<CollectionObservation> {
    this.observations.push(structuredClone(selection));
    await this.beforeObserve?.();
    const source = selection.root.name === "Catalog";
    const keys = source ? this.keys : ["private-existing", this.added ?? "private-missing"];
    return { complete: true, order: "dom", conditions: [], items: keys.map((key, position) => {
      const ref = `ref:${this.observations.length}:${position}`;
      this.refs.set(ref, { key, source });
      return { position, disabled: false, target: { role: "button", name: source ? "Add" : "Select", ref, disabled: false, occluded: false },
        choice: { complete: true, key, values: selection.choice!.where.map(predicate =>
          predicate.attribute === "data-resource-id" ? key : String(this.available[position])) } };
    }) };
  }
  async clickWithSelectedItemEvidence(_target: Target, ref: string, _key: SelectedItemKey): Promise<ResourceKeyObservation> {
    this.attempts++;
    await this.beforeDispatch?.(ref);
    const entry = this.refs.get(ref)!;
    this.mutations.push(entry.key);
    if (entry.source) this.added = entry.key;
    this.selected = entry.key;
    await this.afterDispatch?.();
    return this.complete ? { complete: true, value: entry.key } : { complete: false };
  }
  async readResourceKey(): Promise<ResourceKeyObservation> { return { complete: true, value: this.destination ?? this.selected }; }
}
const replay = (driver: ChoiceDriver, f = fixture(), extra: Parameters<typeof runScenario>[1] = {}) =>
  runScenario(f.scenario, { driver, reporter, custom, judgmentKey: "choice-v1",
    selectedItemEvidence: { bindings: [f.binding] }, ...extra });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("predicate selection bound to this run", () => {
  it("selects eligible B and then only the added B, with fresh private reference values", async () => {
    const driver = new ChoiceDriver(), f = fixture(), saved = JSON.stringify(f.scenario);
    const events: unknown[] = [];
    const { result } = await replay(driver, f, { trace: { emit(event) { events.push(event); } } });
    expect(result.verdict.passed).toBe(true);
    expect(driver.mutations).toEqual(["private-B", "private-B"]);
    expect(driver.observations[1]?.choice?.where[0]?.value).toBe("private-B");
    expect(JSON.stringify(f.scenario)).toBe(saved);
    expect(JSON.stringify({ result, events })).not.toMatch(/private-(?:A|B|existing)|ref:/);
    expect(result.usage?.llmCalls).toBe(0);
    expect(result.evidence.selectedItems?.[0]?.selectionAttempts).toHaveLength(2);
  });

  it("obtains fresh eligibility and binding values on each invocation", async () => {
    const driver = new ChoiceDriver();
    const first = await replay(driver);
    driver.available = [true, true];
    const second = await replay(driver);
    expect(first.result.verdict.passed).toBe(true);
    expect(second.result.verdict.passed).toBe(true);
    expect(driver.mutations).toEqual(["private-B", "private-B", "private-A", "private-A"]);
    expect(first.result.evidence.selectedItemRunId).not.toBe(second.result.evidence.selectedItemRunId);
  });

  it("reselects once only after the exact reference is certified not dispatched", async () => {
    const driver = new ChoiceDriver(); driver.available = [true, true];
    driver.beforeDispatch = ref => {
      if (driver.attempts === 1) { driver.available = [false, true]; throw new SelectionNotDispatchedError(ref); }
    };
    const { result } = await replay(driver);
    expect(result.verdict.passed).toBe(true);
    expect(driver.attempts).toBe(3);
    expect(driver.mutations).toEqual(["private-B", "private-B"]);
    const record = result.evidence.selectedItems![0]!;
    expect(record.selectionAttempts?.map(attempt => attempt.dispatch)).toEqual(["not-dispatched", "dispatched", "dispatched"]);
    expect(record.sourceAttemptId).toBe(`${record.sourceActionId}:selection:1`);
  });

  it.each(["generic-stale", "wrong-ref", "transport"])("does not reselect after %s", async kind => {
    const driver = new ChoiceDriver();
    driver.beforeDispatch = () => {
      if (kind === "generic-stale") throw new CollectionSelectionError("stale", "changed");
      if (kind === "wrong-ref") throw new SelectionNotDispatchedError("another-ref");
      throw new Error("transport interrupted");
    };
    const { result } = await replay(driver);
    expect(result.verdict.passed).toBe(false);
    expect(driver.attempts).toBe(1);
    expect(driver.mutations).toEqual([]);
    expect(driver.observations).toHaveLength(1);
  });

  it("stops after the explicitly bounded reselection allowance", async () => {
    const driver = new ChoiceDriver(); driver.beforeDispatch = ref => { throw new SelectionNotDispatchedError(ref); };
    const { result } = await replay(driver);
    expect(result.verdict.passed).toBe(false);
    expect(driver.attempts).toBe(2);
    expect(driver.mutations).toEqual([]);
  });

  it.each(["throw", "incomplete"])("does not repeat an actual mutation after %s", async failure => {
    const driver = new ChoiceDriver();
    if (failure === "throw") driver.afterDispatch = () => { throw new Error("response lost after mutation"); };
    else driver.complete = false;
    const { result } = await replay(driver);
    expect(result.verdict.passed).toBe(false);
    expect(driver.attempts).toBe(1);
    expect(driver.mutations).toEqual(["private-B"]);
    expect(driver.observations).toHaveLength(1);
  });

  it("fails independently observed C despite successful selection and navigation", async () => {
    const driver = new ChoiceDriver(); driver.destination = "private-C";
    const { result } = await replay(driver);
    expect(result.verdict.results[0]).toMatchObject({ passed: false });
    expect(result.verdict.results[0]?.reason).toBeUndefined();
    expect(driver.mutations).toEqual(["private-B", "private-B"]);
  });

  it("does not restart the source when a dependent action becomes stale", async () => {
    const driver = new ChoiceDriver();
    driver.beforeDispatch = ref => { if (driver.attempts === 2) throw new SelectionNotDispatchedError(ref); };
    const { result } = await replay(driver);
    expect(result.verdict.passed).toBe(false);
    expect(driver.attempts).toBe(2);
    expect(driver.mutations).toEqual(["private-B"]);
  });

  it("refuses absent runtime bindings before dispatch", async () => {
    const driver = new ChoiceDriver();
    await expect(replay(driver, fixture(), { selectedItemEvidence: undefined })).rejects.toThrow(/bindings/);
    expect(driver.observations).toHaveLength(0);
  });

  it.each(["unpersisted", "wrong-prefix", "future-reference", "expired-reference", "non-click"])("rejects %s authoring before dispatch", async invalid => {
    const driver = new ChoiceDriver(), f = fixture();
    if (invalid === "unpersisted") f.scenario.assertions = [{ kind: "navigated" }];
    if (invalid === "wrong-prefix") (f.scenario.steps[0] as Step & { kind: "click" }).target.collection!.root.name = "Another catalog";
    if (invalid === "future-reference") f.scenario.steps = [f.scenario.steps[1]!, f.scenario.steps[0]!];
    if (invalid === "expired-reference") f.binding.destination.after = [f.scenario.steps[0]!];
    if (invalid === "non-click") f.scenario.steps[1] = { kind: "hover", target: choice("Cart", true).target };
    // Separate persisted declarations from mutable scenario data before editing the path.
    if (invalid === "wrong-prefix") f.binding.source.after = [choice("Catalog")];
    await expect(replay(driver, f)).rejects.toThrow();
    expect(driver.attempts).toBe(0);
  });

  it("cannot use a Driver without the combined capture-and-dispatch capability", async () => {
    const driver = new ChoiceDriver();
    Object.defineProperty(driver, "clickWithSelectedItemEvidence", { value: undefined });
    const { result } = await replay(driver);
    expect(result.verdict.passed).toBe(false);
    expect(driver.observations).toHaveLength(0);
    expect(driver.clicked).toEqual([]);
  });

  it("rejects a changed middle action before a dependent choice can dispatch", async () => {
    const driver = new ChoiceDriver(), f = fixture();
    const middle: Step = { kind: "goto", url: "https://app/cart" };
    f.binding.destination.after = [f.scenario.steps[0]!, middle, f.scenario.steps[1]!];
    f.scenario.steps = [f.scenario.steps[0]!, { ...middle, url: "https://app/another-cart" }, f.scenario.steps[1]!];
    await expect(replay(driver, f)).rejects.toThrow(/binding/);
    expect(driver.attempts).toBe(0);
  });

  it("keeps public rediscovery decisions from granting selection or restart permission", async () => {
    const driver = new ChoiceDriver(); driver.destination = "private-C";
    const f = fixture(), { result } = await replay(driver, f);
    for (const decide of [nodeEligibility, browserEligibility])
      expect(decide(f.scenario, result)).toEqual({ eligible: false, reason: "predicate-selection" });
  });

  it("reports predicate rather than positional selection in freeze diagnostics", () => {
    expect(scoreTarget(choice("Catalog").target)).toMatchObject({ weak: false });
    expect(scoreTarget(choice("Catalog").target).reason).toContain("predicate choice");
  });

  it("checks the executed dependent prefix again even after valid authoring", async () => {
    const driver = new ChoiceDriver(), f = fixture();
    const source = f.scenario.steps[0] as Step & { kind: "click" };
    const dependent = f.scenario.steps[1] as Step & { kind: "click" };
    const middle: Step = { kind: "goto", url: "https://app/cart" };
    f.binding.destination.after = [source, middle, dependent];
    f.scenario.steps = [source, middle, dependent];
    const session = new SelectedItemEvidenceSession({ bindings: [f.binding] });
    session.validateScenario(f.scenario);
    const first = session.driverFor(source, driver);
    const resolved = await resolveCollectionTarget(first, source.target);
    await first.click(resolved.target, resolved.ref);
    await session.after({ step: source, ok: true }, driver);
    await session.after({ step: { ...middle, url: "https://app/changed" }, ok: true }, driver);
    await expect(resolveCollectionTarget(session.driverFor(dependent, driver), dependent.target)).rejects.toThrow(/unavailable/);
    expect(driver.mutations).toEqual(["private-B"]);
    expect(session.finish()[0]?.complete).toBe(false);
  });

  it("rejects a changed dependent collection scope with the original binding", async () => {
    const driver = new ChoiceDriver(), f = fixture();
    f.scenario.steps = [f.scenario.steps[0]!, choice("Another cart", true)];
    await expect(replay(driver, f)).rejects.toThrow(/binding/);
    expect(driver.attempts).toBe(0);
  });

  it.each(["heal", "targetChoice"])("never grants %s permission", async mode => {
    const driver = new ChoiceDriver();
    await expect(replay(driver, fixture(), mode === "heal" ? { heal: true }
      : { targetChoice: { selector: { select: vi.fn() }, minConfidence: null } })).rejects.toThrow();
    expect(driver.attempts).toBe(0);
  });

  it("keeps cancellation between attempts from dispatching a replacement", async () => {
    const driver = new ChoiceDriver(), controller = new AbortController();
    driver.beforeDispatch = ref => { controller.abort(new Error("stop selection")); throw new SelectionNotDispatchedError(ref); };
    await expect(replay(driver, fixture(), { signal: controller.signal })).rejects.toThrow("stop selection");
    expect(driver.attempts).toBe(1);
    expect(driver.mutations).toEqual([]);
  });

  it("checks the acceptance deadline before recapturing a replacement", async () => {
    const driver = new ChoiceDriver();
    driver.beforeDispatch = async ref => { await new Promise(resolve => setTimeout(resolve, 15)); throw new SelectionNotDispatchedError(ref); };
    const f = fixture();
    const { result } = await replay(driver, f, { selectedItemEvidence: { bindings: [f.binding], timeoutMs: 5 } });
    expect(result.verdict.passed).toBe(false);
    expect(driver.attempts).toBe(1);
    expect(driver.observations).toHaveLength(1);
    expect(result.evidence.selectedItems?.[0]?.status).toBe("timed-out");
  });

  it("does not dispatch a replacement after the shared budget expires", async () => {
    const driver = new ChoiceDriver();
    driver.beforeDispatch = async ref => { await new Promise(resolve => setTimeout(resolve, 20)); throw new SelectionNotDispatchedError(ref); };
    const { result } = await replay(driver, fixture(), { budget: { timeoutMs: 10 } });
    expect(result.verdict.failure).toBe("budget");
    expect(driver.mutations).toEqual([]);
    expect(driver.attempts).toBeLessThanOrEqual(1);
  });

  it.each(["source-same-boundary", "source-later-boundary", "dependent"])("retains the timeout reason after a late %s receipt", async boundary => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const driver = new ChoiceDriver(), f = fixture();
    const attempts = boundary === "dependent" ? 2 : 1;
    if (boundary === "source-same-boundary") {
      f.scenario.steps = f.scenario.steps.slice(0, 1);
      f.binding.destination.after = f.scenario.steps;
    }
    driver.afterDispatch = () => { if (driver.attempts === attempts) now = 100; };
    const read = vi.spyOn(driver, "readResourceKey");
    const { result } = await replay(driver, f, { selectedItemEvidence: { bindings: [f.binding], timeoutMs: 50 } });
    expect(result.verdict.passed).toBe(false);
    expect(result.verdict.results[0]).toMatchObject({ reason: "inconclusive", required: true });
    expect(result.evidence.selectedItems?.[0]).toMatchObject({ status: "timed-out", complete: false });
    expect(result.evidence.selectedItems?.[0]?.equal).toBeUndefined();
    expect(result.evidence.execution.actions.at(-1)?.ok).toBe(false);
    expect(driver.attempts).toBe(attempts);
    expect(driver.mutations).toHaveLength(attempts);
    expect(driver.observations).toHaveLength(attempts);
    expect(read).not.toHaveBeenCalled();
  });

  it("drains replacement observation after cancellation without another dispatch", async () => {
    const driver = new ChoiceDriver(), controller = new AbortController();
    const entered = deferred(), release = deferred();
    driver.beforeDispatch = ref => { throw new SelectionNotDispatchedError(ref); };
    driver.beforeObserve = async () => {
      if (driver.observations.length === 2) { entered.resolve(); await release.promise; }
    };
    let settled = false;
    const stopped = replay(driver, fixture(), { signal: controller.signal }).then(
      () => { settled = true; throw new Error("cancelled replay unexpectedly completed"); },
      error => { settled = true; return error; },
    );
    await entered.promise;
    const reason = new Error("stop replacement observation");
    controller.abort(reason);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(driver.attempts).toBe(1);
    release.resolve();
    expect(await stopped).toBe(reason);
    expect(driver.observations).toHaveLength(2);
    expect(driver.attempts).toBe(1);
    expect(driver.mutations).toEqual([]);
  });

  it("keeps the source timeout separate from an unreached binding", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const driver = new ChoiceDriver(), f = fixture();
    const laterPath = [...f.scenario.steps, choice("Catalog")];
    const later: SelectedItemBinding = { ...structuredClone(f.binding), id: "later-item",
      source: { after: laterPath, key: identity }, destination: { ...f.binding.destination, after: laterPath } };
    const session = new SelectedItemEvidenceSession({ bindings: [f.binding, later], timeoutMs: 50 });
    driver.afterDispatch = () => { now = 100; };
    const source = f.scenario.steps[0] as Step & { kind: "click" };
    const wrapped = session.driverFor(source, driver);
    const resolved = await resolveCollectionTarget(wrapped, source.target);
    await expect(wrapped.click(resolved.target, resolved.ref)).rejects.toThrow(/continuity/);
    await session.after({ step: source, ok: false }, driver);
    const records = session.finish();
    expect(records.map(record => record.status)).toEqual(["timed-out", "skipped"]);
    expect(records.every(record => !record.complete && record.equal === undefined)).toBe(true);
    expect(driver.mutations).toEqual(["private-B"]);
  });

  it("does not replace a late transport error with an acceptance timeout", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const driver = new ChoiceDriver(), f = fixture();
    driver.afterDispatch = () => { now = 100; throw new Error("receipt transport failed"); };
    const { result } = await replay(driver, f, { selectedItemEvidence: { bindings: [f.binding], timeoutMs: 50 } });
    expect(result.verdict.passed).toBe(false);
    expect(result.evidence.selectedItems?.[0]?.status).not.toBe("timed-out");
    expect(driver.attempts).toBe(1);
    expect(driver.mutations).toEqual(["private-B"]);
  });

  it.each([false, true])("drains replacement observation when the budget expires (workflow: %s)", async workflow => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const driver = new ChoiceDriver(), entered = deferred(), release = deferred();
    driver.beforeDispatch = ref => { throw new SelectionNotDispatchedError(ref); };
    driver.beforeObserve = async () => {
      if (driver.observations.length === 2) { entered.resolve(); await release.promise; }
    };
    let settled = false;
    let sibling: WorkflowLease | undefined;
    const run = workflow
      ? runWorkflow({ budget: { timeoutMs: 1_000 } }, owner => {
        sibling = owner.borrow("later-work");
        return replay(driver, fixture(), { workflow: owner.borrow("selection") });
      })
      : replay(driver, fixture(), { budget: { timeoutMs: 1_000 } });
    const stopped = run.then(value => { settled = true; return value; });
    await entered.promise;
    now = 1_001;
    await vi.advanceTimersByTimeAsync(1_001);
    expect(settled).toBe(false);
    if (sibling) {
      expect(sibling.signal.aborted).toBe(true);
      const work = vi.fn(async () => {});
      await expect(sibling.operation("must-not-dispatch", work)).rejects.toThrow(/budget exhausted/i);
      expect(work).not.toHaveBeenCalled();
    }
    release.resolve();
    const outcome = await stopped;
    if ("status" in outcome) expect(outcome.status).toBe("exhausted");
    else expect(outcome.result.verdict).toMatchObject({ passed: false, failure: "budget" });
    expect(driver.observations).toHaveLength(2);
    expect(driver.attempts).toBe(1);
    expect(driver.mutations).toEqual([]);
  });

  it("retains an acceptance timeout during replacement observation without dispatching again", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const driver = new ChoiceDriver(), f = fixture(), entered = deferred(), release = deferred();
    driver.beforeDispatch = ref => { throw new SelectionNotDispatchedError(ref); };
    driver.beforeObserve = async () => {
      if (driver.observations.length === 2) { entered.resolve(); await release.promise; }
    };
    const run = replay(driver, f, { selectedItemEvidence: { bindings: [f.binding], timeoutMs: 50 } });
    await entered.promise;
    now = 100;
    release.resolve();
    const { result } = await run;
    expect(result.verdict.passed).toBe(false);
    expect(result.evidence.selectedItems?.[0]).toMatchObject({ status: "timed-out", complete: false });
    expect(result.evidence.selectedItems?.[0]?.selectionAttempts?.map(attempt => attempt.dispatch)).toEqual(["not-dispatched"]);
    expect(driver.observations).toHaveLength(2);
    expect(driver.attempts).toBe(1);
    expect(driver.mutations).toEqual([]);
  });

  it("includes explicit predicate changes in the declared judgment contract", async () => {
    const one = fixture(), two = fixture();
    (two.scenario.steps[0] as Step & { kind: "click" }).target.collection!.choice!.where[0]!.value = "another-state";
    const first = await identifyScenario(one.scenario, { intent: "choose and review an eligible item", judgmentKey: "choice-v1" });
    const second = await identifyScenario(two.scenario, { intent: "choose and review an eligible item", judgmentKey: "choice-v1" });
    expect(compareContracts(first.contract, second.contract)).toBe("changed");
  });
});
