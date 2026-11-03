import { afterEach, describe, expect, it, vi } from "vitest";
import { runScenario } from "../src/run.js";
import { runHarness } from "../src/core/pipeline.js";
import { AssertionCritic } from "../src/adapters/critics/assertion.js";
import { InlineContextProvider } from "../src/adapters/context/inline.js";
import { StaticPlanner } from "../src/adapters/planners/static.js";
import { identifyScenario, compareContracts } from "../src/core/contract.js";
import { selectedItemEquals } from "../src/core/selected-item-evidence.js";
import type { SelectedItemBinding, SelectedItemKey, DestinationResourceKey, ResourceKeyObservation } from "../src/core/selected-item-evidence.js";
import type { CollectionObservation, CollectionTarget, Evidence, Scenario, Step, Target } from "../src/core/types.js";
import { StubDriver } from "./support/doubles.js";

const reporter = { emit: async () => {} };
const custom = { "selected-item-equals": selectedItemEquals };
const params = (binding: SelectedItemBinding): Record<string, unknown> => binding as unknown as Record<string, unknown>;
const collectionClick = (name = "Results"): Step => ({ kind: "click", target: { collection: {
  root: { role: "list", name }, itemRole: "listitem", target: { role: "button", name: "Open" },
  order: "dom", index: 0, expectedCount: 2,
} } });
const click = collectionClick();
const binding = (source: Step[] = [click], destination: Step[] = source, id = "selected-resource"): SelectedItemBinding => ({
  version: 1, id, relation: "resource-key-equals", phase: "replay",
  source: { after: structuredClone(source), key: { kind: "attribute", scope: "item", attribute: "data-resource-id" } },
  destination: { after: structuredClone(destination), key: { kind: "attribute", selector: "#details", attribute: "data-resource-id" } },
});
const scenario = (bindings: SelectedItemBinding[] = [binding()], steps: Step[] = [click]): Scenario => ({
  name: "open-current-first-resource", steps: structuredClone(steps), assertions: [
    ...bindings.map(item => ({ kind: "custom" as const, name: "selected-item-equals", params: params(item) })),
    { kind: "navigated", to: "https://app/details" },
  ],
});

/** The driver owns exact-node dispatch; the core sees only the explicitly requested key. */
class ResourceDriver extends StubDriver {
  keys = ["resource-A", "resource-B"];
  otherKeys = ["other-A", "other-B"];
  destinationOverride?: string;
  sourceComplete = true;
  destinationComplete = true;
  boundCalls = 0;
  readCalls = 0;
  selectedKey?: string;
  sourceRefs: string[] = [];
  destinationKeys: DestinationResourceKey[] = [];
  afterBoundClick?: () => void | Promise<void>;
  private readonly refs = new Map<string, string>();

  async observeCollection(selection: CollectionTarget): Promise<CollectionObservation> {
    const keys = selection.root.name === "Other results" ? this.otherKeys : this.keys;
    return { complete: true, order: "dom", conditions: [], items: keys.map((key, position) => {
      const ref = `private-ref:${selection.root.name}:${position}:${this.boundCalls}`;
      this.refs.set(ref, key);
      return { position, target: { role: "button", name: "Open", ref } };
    }) };
  }

  override async click(target: Target): Promise<void> {
    await super.click(target);
    this.url = "https://app/details";
    this.selectedKey = this.keys[0];
  }

  async clickWithSelectedItemEvidence(target: Target, ref: string, _source: SelectedItemKey): Promise<ResourceKeyObservation> {
    this.boundCalls++;
    this.sourceRefs.push(ref);
    const key = this.refs.get(ref);
    await this.click(target);
    this.selectedKey = key;
    await this.afterBoundClick?.();
    return this.sourceComplete && key !== undefined ? { complete: true, value: key } : { complete: false };
  }

  async readResourceKey(destination: DestinationResourceKey): Promise<ResourceKeyObservation> {
    this.readCalls++;
    this.destinationKeys.push(structuredClone(destination));
    const key = this.destinationOverride ?? this.selectedKey;
    return this.destinationComplete && key !== undefined ? { complete: true, value: key } : { complete: false };
  }
}

function replay(driver = new ResourceDriver(), bindings = [binding()], steps: Step[] = [click]) {
  return runScenario(scenario(bindings, steps), { driver, reporter, custom, judgmentKey: "selected-resource-v1",
    selectedItemEvidence: { bindings } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("run-local selected-item resource equality", () => {
  it("binds each replay to its current first resource with zero model calls", async () => {
    const firstDriver = new ResourceDriver();
    const first = (await replay(firstDriver)).result;
    const secondDriver = new ResourceDriver(); secondDriver.keys.reverse();
    const second = (await replay(secondDriver)).result;
    expect(first.verdict.passed).toBe(true);
    expect(second.verdict.passed).toBe(true);
    expect(firstDriver.selectedKey).toBe("resource-A");
    expect(secondDriver.selectedKey).toBe("resource-B");
    expect(second.evidence.selectedItemRunId).not.toBe(first.evidence.selectedItemRunId);
    expect(first.usage?.llmCalls).toBe(0);
    expect(second.usage?.llmCalls).toBe(0);
    expect(firstDriver.boundCalls).toBe(1);
    expect(secondDriver.boundCalls).toBe(1);
    expect(secondDriver.clicked).toEqual(["Open"]);
  });

  it.each(["resource-A", "resource-C"])("fails when current B opens independently observed %s", async destination => {
    const driver = new ResourceDriver(); driver.keys.reverse(); driver.destinationOverride = destination;
    const { result } = await replay(driver);
    expect(result.verdict.passed).toBe(false);
    expect(result.verdict.results[0]).toMatchObject({ passed: false });
    expect(result.verdict.results[0]?.reason).not.toBe("inconclusive");
    expect(result.verdict.results[1]?.passed).toBe(true);
    expect(driver.clicked).toHaveLength(1);
  });

  it.each(["source", "destination"])("does not confirm a missing %s key from navigation alone", async missing => {
    const driver = new ResourceDriver();
    if (missing === "source") driver.sourceComplete = false;
    else driver.destinationComplete = false;
    const { result } = await replay(driver);
    expect(result.verdict.passed).toBe(false);
    expect(result.verdict.results[0]).toMatchObject({ reason: "inconclusive", required: true, passed: false });
    expect(result.verdict.results[1]?.passed).toBe(true);
    expect(driver.clicked).toHaveLength(1);
  });

  it("does not manufacture source identity from a destination with the same action label", async () => {
    const driver = new ResourceDriver(); driver.sourceComplete = false; driver.destinationOverride = "destination-only-key";
    const { result } = await replay(driver);
    expect(result.verdict.results[0]).toMatchObject({ reason: "inconclusive", required: true });
    expect(result.evidence.selectedItems?.every(row => !row.complete)).toBe(true);
    expect(JSON.stringify(result.evidence.selectedItems)).not.toContain("destination-only-key");
  });

  it("keeps the independently declared fixed-resource check unchanged", async () => {
    const driver = new ResourceDriver(); driver.keys.reverse();
    const authored = scenario();
    authored.assertions.push({ kind: "custom", name: "fixed-A" });
    const { result } = await runScenario(authored, { driver, reporter,
      custom: { ...custom, "fixed-A": () => driver.selectedKey === "resource-A" },
      selectedItemEvidence: { bindings: [binding()] }, judgmentKey: "selected-and-fixed-v1" });
    expect(result.verdict.results[0]?.passed).toBe(true);
    expect(result.verdict.results.at(-1)?.passed).toBe(false);
    expect(result.verdict.passed).toBe(false);
  });

  it("does not activate source reads or bound dispatch for an ordinary unbound scenario", async () => {
    const driver = new ResourceDriver();
    const authored = scenario([], [click]);
    const { result } = await runScenario(authored, { driver, reporter });
    expect(result.verdict.passed).toBe(true);
    expect(driver.boundCalls).toBe(0);
    expect(driver.readCalls).toBe(0);
    expect(driver.clicked).toEqual(["Open"]);
    expect(result.evidence.selectedItems).toBeUndefined();
  });

  it("supports a driver whose own click method cannot be replaced", async () => {
    const driver = new ResourceDriver();
    Object.defineProperty(driver, "click", { value: driver.click.bind(driver), writable: false, configurable: false });
    const { result } = await replay(driver);
    expect(result.verdict.passed).toBe(true);
    expect(driver.boundCalls).toBe(1);
    expect(driver.clicked).toEqual(["Open"]);
  });

  it("keeps a required relation inconclusive when runtime collection is omitted", async () => {
    const driver = new ResourceDriver();
    const { result } = await runScenario(scenario(), { driver, reporter, custom, judgmentKey: "selected-resource-v1" });
    expect(result.verdict.results[0]).toMatchObject({ reason: "inconclusive", required: true });
    expect(result.verdict.passed).toBe(false);
    expect(driver.boundCalls).toBe(0);
  });

  it.each(["clickWithSelectedItemEvidence", "readResourceKey"] as const)("refuses to confirm without driver capability %s", async method => {
    const driver = new ResourceDriver();
    Object.defineProperty(driver, method, { value: undefined });
    const { result } = await replay(driver);
    expect(result.verdict.passed).toBe(false);
    expect(result.verdict.results[0]).toMatchObject({ reason: "inconclusive", required: true });
    expect(driver.clicked.length).toBeLessThanOrEqual(1);
  });

  it("does not retry a mutation when the destination read fails", async () => {
    const driver = new ResourceDriver();
    driver.readResourceKey = async () => { throw new Error("destination unavailable"); };
    const { result } = await replay(driver);
    expect(result.verdict.results[0]).toMatchObject({ reason: "inconclusive", required: true });
    expect(driver.clicked).toEqual(["Open"]);
    expect(driver.boundCalls).toBe(1);
  });

  it("does not retry a mutation when the source receipt fails after the click", async () => {
    const driver = new ResourceDriver();
    driver.afterBoundClick = () => { throw new Error("receipt unavailable"); };
    const { result } = await replay(driver);
    expect(result.verdict.passed).toBe(false);
    expect(result.verdict.results[0]).toMatchObject({ reason: "inconclusive", required: true });
    expect(driver.clicked).toEqual(["Open"]);
    expect(driver.boundCalls).toBe(1);
  });

  it("rejects automatic healing before any mutation or model call", async () => {
    const driver = new ResourceDriver();
    const complete = vi.fn(async () => { throw new Error("no model work belongs in this relation"); });
    await expect(runScenario(scenario(), { driver, reporter, custom,
      selectedItemEvidence: { bindings: [binding()] }, heal: true, llm: { id: "must-not-run", complete } })).rejects.toThrow();
    expect(driver.boundCalls).toBe(0);
    expect(driver.clicked).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(["source", "destination"])("rejects malformed %s observations without invoking data accessors", async side => {
    const driver = new ResourceDriver(); const getter = vi.fn(() => "resource-A");
    const observation = Object.defineProperty({ complete: true }, "value", { enumerable: true, get: getter });
    if (side === "source") {
      const dispatch = driver.clickWithSelectedItemEvidence.bind(driver);
      driver.clickWithSelectedItemEvidence = async (...args) => { await dispatch(...args); return observation; };
    } else driver.readResourceKey = async () => observation;
    const { result } = await replay(driver);
    expect(result.verdict.results[0]).toMatchObject({ reason: "inconclusive", required: true });
    expect(getter).not.toHaveBeenCalled();
    expect(driver.clicked).toEqual(["Open"]);
  });

  it.each(["", " ", "x".repeat(257)])("requires a nonempty bounded resource key (%j)", async value => {
    const driver = new ResourceDriver(); driver.keys[0] = value;
    const { result } = await replay(driver);
    expect(result.verdict.results[0]).toMatchObject({ reason: "inconclusive", required: true });
    expect(result.verdict.passed).toBe(false);
  });

  it("retains separate action occurrences for repeated identical clicks", async () => {
    const driver = new ResourceDriver();
    const first = binding([click], [click], "first");
    const second = binding([click, click], [click, click], "second");
    driver.afterBoundClick = () => { driver.keys.reverse(); };
    const { result } = await replay(driver, [first, second], [click, click]);
    expect(result.verdict.passed).toBe(true);
    expect(driver.sourceRefs).toHaveLength(2);
    expect(new Set(result.evidence.selectedItems?.map(row => row.sourceActionId)).size).toBe(2);
    expect(driver.clicked).toEqual(["Open", "Open"]);
  });

  it("does not overwrite an earlier collection's binding with a later collection", async () => {
    const other = collectionClick("Other results");
    const first = binding([click], [click], "first-collection");
    const second = binding([click, other], [click, other], "other-collection");
    const driver = new ResourceDriver();
    const { result } = await replay(driver, [first, second], [click, other]);
    expect(result.verdict.passed).toBe(true);
    expect(result.evidence.selectedItems?.map(row => row.equal)).toEqual([true, true]);
    expect(driver.selectedKey).toBe("other-A");
  });

  it("reads destination at its declared boundary before a later action changes the page", async () => {
    const later: Step = { kind: "goto", url: "https://app/elsewhere" };
    const authored = scenario([binding()], [click, later]);
    authored.assertions = authored.assertions.filter(assertion => assertion.kind === "custom");
    const driver = new ResourceDriver();
    driver.goto = async url => { driver.url = url; driver.selectedKey = "later-resource"; };
    const { result } = await runScenario(authored, { driver, reporter, custom, selectedItemEvidence: { bindings: [binding()] } });
    expect(result.verdict.passed).toBe(true);
    expect(driver.readCalls).toBe(1);
    expect(driver.selectedKey).toBe("later-resource");
  });

  it("waits until the declared downstream boundary before comparing the independent key", async () => {
    const readiness: Step = { kind: "waitFor", until: { url: "https://app/details" } };
    const relation = binding([click], [click, readiness]);
    const driver = new ResourceDriver();
    const { result } = await replay(driver, [relation], [click, readiness]);
    expect(result.verdict.passed).toBe(true);
    expect(driver.readCalls).toBe(1);
    expect(result.evidence.selectedItems?.[0]?.destinationActionId).not.toBe(result.evidence.selectedItems?.[0]?.sourceActionId);
  });

  it("does not accept a numeric occurrence when its preceding path was changed", async () => {
    const original: Step = { kind: "goto", url: "https://app/original" };
    const replacement: Step = { kind: "goto", url: "https://app/replacement" };
    const relation = binding([original, click]);
    const { result } = await replay(new ResourceDriver(), [relation], [replacement, click]);
    expect(result.verdict.passed).toBe(false);
    expect(result.verdict.results[0]).toMatchObject({ reason: "inconclusive", required: true });
  });

  it("invalidates binding when an earlier action was skipped", async () => {
    const prior: Step = { kind: "click", target: { text: "Already done" }, expect: { url: "https://app/start" } };
    const relation = binding([prior, click]);
    const { result } = await replay(new ResourceDriver(), [relation], [prior, click]);
    expect(result.evidence.execution.actions[0]?.skipped).toBe(true);
    expect(result.verdict.results[0]).toMatchObject({ reason: "inconclusive", required: true });
  });

  it("does not accept a source click whose post-condition failed", async () => {
    const failed: Step = { ...click, expect: { url: "https://app/not-reached" } };
    const relation = binding([failed]);
    const driver = new ResourceDriver();
    const { result } = await runScenario(scenario([relation], [failed]), { driver, reporter, custom,
      selectedItemEvidence: { bindings: [relation] }, expectTimeoutMs: 0 });
    expect(driver.clicked).toHaveLength(1);
    expect(result.verdict.passed).toBe(false);
    expect(result.verdict.results[0]).toMatchObject({ reason: "inconclusive", required: true });
  });

  it("does not accept records from a previous run or ambiguous duplicate records", async () => {
    const first = (await replay()).result;
    const second = (await replay()).result;
    const stale: Evidence = { ...second.evidence, selectedItems: first.evidence.selectedItems };
    expect(await selectedItemEquals(params(binding()), stale)).toMatchObject({ inconclusive: true, required: true });
    const records = second.evidence.selectedItems!;
    const duplicate: Evidence = { ...second.evidence, selectedItems: [...records, records[0]!] };
    expect(await selectedItemEquals(params(binding()), duplicate)).toMatchObject({ inconclusive: true, required: true });
  });

  it("strips driver-supplied prior binding evidence even when collection is disabled", async () => {
    const old = (await replay()).result.evidence;
    const driver = new ResourceDriver();
    const observe = driver.observe.bind(driver);
    driver.observe = async () => ({ ...await observe(), selectedItems: old.selectedItems, selectedItemRunId: old.selectedItemRunId });
    const { result } = await runScenario(scenario(), { driver, reporter, custom });
    expect(result.evidence.selectedItems).toBeUndefined();
    expect(result.evidence.selectedItemRunId).toBeUndefined();
    expect(result.verdict.results[0]).toMatchObject({ reason: "inconclusive", required: true });
  });

  it("cannot satisfy a persisted relation by changing only runtime extraction settings", async () => {
    const authored = binding();
    const runtime = binding(); runtime.destination.key.attribute = "data-other-id";
    const { result } = await runScenario(scenario([authored]), { driver: new ResourceDriver(), reporter, custom,
      selectedItemEvidence: { bindings: [runtime] } });
    expect(result.verdict.results[0]).toMatchObject({ reason: "inconclusive", required: true });
    expect(result.verdict.passed).toBe(false);
  });

  it("does not export raw keys or selected refs in binding evidence or frozen declarations", async () => {
    const driver = new ResourceDriver(); driver.keys[0] = "private-resource-identity";
    const authored = scenario(); const before = JSON.stringify(authored);
    const events: unknown[] = [];
    const { result } = await runScenario(authored, { driver, reporter, custom, selectedItemEvidence: { bindings: [binding()] },
      trace: { emit: event => { events.push(event); } } });
    expect(result.verdict.passed).toBe(true);
    expect(JSON.stringify(result.evidence)).not.toContain("private-resource-identity");
    expect(JSON.stringify(result.evidence)).not.toContain("private-ref:");
    expect(JSON.stringify(authored)).toBe(before);
    expect(JSON.stringify(authored)).not.toContain("private-resource-identity");
    expect(JSON.stringify(events)).not.toContain("private-resource-identity");
    expect(JSON.stringify(events)).not.toContain("private-ref:");
  });

  it("compares keys before any secret display redaction", async () => {
    const driver = new ResourceDriver(); driver.keys[0] = "private-A"; driver.destinationOverride = "private-B";
    const { result } = await runScenario(scenario(), { driver, reporter, custom,
      selectedItemEvidence: { bindings: [binding()] }, secrets: { first: "private-A", second: "private-B" } });
    expect(result.verdict.results[0]?.passed).toBe(false);
    expect(result.verdict.results[0]?.reason).not.toBe("inconclusive");
    expect(JSON.stringify(result.evidence.selectedItems)).not.toMatch(/private-[AB]/);
  });

  it("changes judgment identity when the declared extraction relation changes", async () => {
    const original = scenario();
    const changed = scenario();
    (changed.assertions[0] as { params: Record<string, unknown> }).params = params({ ...binding(),
      destination: { ...binding().destination, key: { kind: "attribute", selector: "#other-details", attribute: "data-resource-id" } } });
    const first = await identifyScenario(original, { intent: "open first and verify identity", judgmentKey: "selected-resource-v1" });
    const second = await identifyScenario(changed, { intent: "open first and verify identity", judgmentKey: "selected-resource-v1" });
    expect(compareContracts(first.contract, second.contract)).toBe("changed");
    expect(original.contract).toBeUndefined();
  });

  it("keeps runtime collection policy outside the declared judgment fingerprint", async () => {
    const withEvidence = (await replay()).result;
    const without = (await runScenario(scenario(), { driver: new ResourceDriver(), reporter, custom,
      judgmentKey: "selected-resource-v1" })).result;
    expect(withEvidence.verdict.contract?.fingerprint).toBe(without.verdict.contract?.fingerprint);
  });
});

describe("selected-item binding bounds and lifecycle", () => {
  it.each([
    ["phase", (value: SelectedItemBinding) => Object.assign(value, { phase: "heal" })],
    ["relation", (value: SelectedItemBinding) => Object.assign(value, { relation: "label-equals" })],
    ["version", (value: SelectedItemBinding) => Object.assign(value, { version: 2 })],
    ["source attribute", (value: SelectedItemBinding) => { value.source.key.attribute = "value"; }],
    ["destination attribute", (value: SelectedItemBinding) => { value.destination.key.attribute = "innerHTML"; }],
    ["empty selector", (value: SelectedItemBinding) => { value.destination.key.selector = ""; }],
    ["long selector", (value: SelectedItemBinding) => { value.destination.key.selector = "a".repeat(513); }],
    ["empty prefix", (value: SelectedItemBinding) => { value.source.after = []; }],
    ["legacy source", (value: SelectedItemBinding) => { value.source.after = [{ kind: "click", target: { text: "Open" } }]; }],
    ["different destination prefix", (value: SelectedItemBinding) => { value.destination.after = [{ kind: "goto", url: "https://app" }]; }],
    ["unexpected raw value", (value: SelectedItemBinding) => { Object.assign(value.source.key, { value: "previous-key" }); }],
  ] as const)("rejects an invalid %s declaration before mutation", async (_label, mutate) => {
    const driver = new ResourceDriver(); const invalid = binding(); mutate(invalid);
    await expect(replay(driver, [invalid])).rejects.toThrow();
    expect(driver.clicked).toEqual([]);
  });

  it("rejects duplicate IDs, duplicate source occurrences and excessive bindings before mutation", async () => {
    for (const items of [[binding(), binding()], [binding(), binding([click], [click], "another")],
      Array.from({ length: 33 }, (_, i) => binding(Array.from({ length: i + 1 }, () => click), undefined, `binding-${i}`))]) {
      const driver = new ResourceDriver();
      await expect(replay(driver, items)).rejects.toThrow();
      expect(driver.clicked).toEqual([]);
    }
  });

  it("rejects accessor-bearing declarations without reading the accessor", async () => {
    const invalid = binding(); const getter = vi.fn(() => "data-resource-id");
    Object.defineProperty(invalid.source.key, "attribute", { enumerable: true, get: getter });
    const driver = new ResourceDriver();
    await expect(replay(driver, [invalid])).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(driver.clicked).toEqual([]);
  });

  it("rejects custom step dispatch chains instead of treating their actions as built-in collection clicks", async () => {
    const driver = new ResourceDriver(); const execute = vi.fn(async () => {});
    await expect(runHarness({ driver, reporter, context: new InlineContextProvider(), planner: new StaticPlanner(scenario()),
      critic: new AssertionCritic(custom) }, "open first", {
      stepHandlers: [{ supports: () => true, execute }], selectedItemEvidence: { bindings: [binding()] },
    })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(driver.clicked).toEqual([]);
  });

  it("rejects surgical healing that could replace an earlier action in the bound path", async () => {
    const driver = new ResourceDriver();
    const earlier: Step = { kind: "click", target: { text: "Original" }, expect: { url: "https://app/list" } };
    const relation = binding([earlier, click]);
    const heal = vi.fn(async () => null);
    await expect(runHarness({ driver, reporter, context: new InlineContextProvider(),
      planner: new StaticPlanner(scenario([relation], [earlier, click])), critic: new AssertionCritic(custom) }, "open first", {
      stepHealer: { heal }, selectedItemEvidence: { bindings: [relation] },
    })).rejects.toThrow();
    expect(heal).not.toHaveBeenCalled();
    expect(driver.clicked).toEqual([]);
  });

  it("rejects target-choice repair before it can substitute an earlier locator", async () => {
    const driver = new ResourceDriver();
    const earlier: Step = { kind: "click", target: { text: "Original" }, expect: { url: "https://app/list" } };
    const relation = binding([earlier, click]);
    const select = vi.fn(async () => { throw new Error("repair must not run"); });
    await expect(runScenario(scenario([relation], [earlier, click]), { driver, reporter, custom,
      targetChoice: { selector: { select }, minConfidence: null }, selectedItemEvidence: { bindings: [relation] },
    })).rejects.toThrow();
    expect(select).not.toHaveBeenCalled();
    expect(driver.clicked).toEqual([]);
  });

  it("snapshots capture declarations before awaiting the browser", async () => {
    const driver = new ResourceDriver(); const entered = deferred<void>(); const release = deferred<void>();
    driver.afterBoundClick = async () => { entered.resolve(); await release.promise; };
    const runtime = binding(); const authored = structuredClone(runtime);
    const running = runScenario(scenario([authored]), { driver, reporter, custom, selectedItemEvidence: { bindings: [runtime] } });
    await entered.promise;
    runtime.destination.key.attribute = "data-changed";
    (runtime.destination.after as Step[]).length = 0;
    release.resolve();
    const { result } = await running;
    expect(result.verdict.passed).toBe(true);
    expect(driver.destinationKeys[0]?.attribute).toBe("data-resource-id");
  });

  it("discards late destination evidence without retrying or abandoning the in-flight read", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const driver = new ResourceDriver(); const entered = deferred<void>(); const read = deferred<ResourceKeyObservation>();
    driver.readResourceKey = async () => { entered.resolve(); return read.promise; };
    const running = runScenario(scenario(), { driver, reporter, custom, selectedItemEvidence: { bindings: [binding()], timeoutMs: 10 } });
    await entered.promise; now = 11; read.resolve({ complete: true, value: "resource-A" });
    const { result } = await running;
    expect(result.verdict.passed).toBe(false);
    expect(result.verdict.results[0]).toMatchObject({ reason: "inconclusive", required: true });
    expect(driver.clicked).toEqual(["Open"]);
  });

  it("discards a late source receipt without a second click or downstream key read", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const driver = new ResourceDriver(); const entered = deferred<void>(); const release = deferred<void>();
    driver.afterBoundClick = async () => { entered.resolve(); await release.promise; };
    const running = runScenario(scenario(), { driver, reporter, custom,
      selectedItemEvidence: { bindings: [binding()], timeoutMs: 10 } });
    await entered.promise; now = 11; release.resolve();
    const { result } = await running;
    expect(result.verdict.passed).toBe(false);
    expect(result.verdict.results[0]).toMatchObject({ reason: "inconclusive", required: true });
    expect(driver.clicked).toEqual(["Open"]);
    expect(driver.readCalls).toBe(0);
  });

  it("includes destination reads in the shared execution budget and does not advance after exhaustion", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const driver = new ResourceDriver(); const entered = deferred<void>(); const read = deferred<ResourceKeyObservation>();
    const later: Step = { kind: "click", target: { text: "Later" } };
    driver.readResourceKey = async () => { entered.resolve(); return read.promise; };
    const running = runScenario(scenario([binding()], [click, later]), { driver, reporter, custom,
      selectedItemEvidence: { bindings: [binding()] }, budget: { timeoutMs: 10 } });
    await entered.promise; now = 11; read.resolve({ complete: true, value: "resource-A" });
    const { result } = await running;
    expect(result.verdict).toMatchObject({ passed: false, failure: "budget" });
    expect(driver.clicked).toEqual(["Open"]);
  });

  it("does not judge an interrupted source dispatch or reuse it on the next invocation", async () => {
    const controller = new AbortController(); const driver = new ResourceDriver();
    const judge = vi.fn(new AssertionCritic(custom).judge.bind(new AssertionCritic(custom)));
    driver.afterBoundClick = () => controller.abort();
    await expect(runHarness({ driver, reporter, context: new InlineContextProvider(), planner: new StaticPlanner(scenario()),
      critic: { judge } }, "open first", { signal: controller.signal, selectedItemEvidence: { bindings: [binding()] } })).rejects.toThrow();
    expect(judge).not.toHaveBeenCalled();
    expect(driver.clicked).toEqual(["Open"]);
    driver.afterBoundClick = undefined; driver.sourceComplete = false;
    const next = (await replay(driver)).result;
    expect(next.verdict.results[0]).toMatchObject({ reason: "inconclusive", required: true });
  });

  it("exports the deterministic helper from both public entry points", async () => {
    const node = await import("../src/index.js");
    const browser = await import("../src/browser.js");
    expect(node.selectedItemEquals).toBe(selectedItemEquals);
    expect(browser.selectedItemEquals).toBe(selectedItemEquals);
  });
});
