import { describe, expect, it, vi } from "vitest";
import { CollectionSelectionError, resolveCollectionTarget, validateCollectionTarget } from "../src/core/collection.js";
import { BuiltinStepHandler } from "../src/core/steps.js";
import { StubDriver } from "./support/doubles.js";
import type { CollectionObservation, CollectionTarget, Driver, Step, Target } from "../src/index.js";
import { runHarness } from "../src/core/pipeline.js";

const selection: CollectionTarget = {
  root: { role: "list", name: "Results" }, itemRole: "listitem", target: { role: "button", name: "Open" },
  order: "dom", index: 0, expectedCount: 2,
  conditions: [{ control: { role: "textbox", name: "Search" }, value: "books" }],
};
const target = (): Target => ({ collection: structuredClone(selection) });
const observation = (): CollectionObservation => ({ order: "dom", complete: true,
  items: [0, 1].map(position => ({ position, target: { role: "button", name: "Open", ref: `ref-${position}` } })),
  conditions: [{ value: "books" }],
});
function driver(facts = observation()): Driver & { observeCollection: ReturnType<typeof vi.fn> } {
  return Object.assign(new StubDriver(), { observeCollection: vi.fn(async () => facts) });
}

describe("collection declaration validation", () => {
  it("copies nested declaration data without modifying the caller", () => {
    const authored = target();
    const copy = validateCollectionTarget(authored);
    copy.root.name = "Other";
    copy.conditions![0]!.value = "other";
    expect(authored.collection).toEqual(selection);
  });
  it.each([
    { collection: undefined }, { collection: null }, { collection: {} },
    { collection: { ...selection, order: "visual" } },
    { collection: { ...selection, index: -1 } },
    { collection: { ...selection, index: 0.5 } },
    { collection: { ...selection, expectedCount: Infinity } },
    { collection: { ...selection, itemRole: "row" } },
    { collection: { ...selection, root: { role: "list" } } },
    { collection: { ...selection, root: { role: "listbox", name: "Results" } } },
    { collection: { ...selection, target: { role: "" } } },
    { collection: { ...selection, ref: "runtime-handle" } },
    { collection: { ...selection, conditions: [{}] } },
    { collection: { ...selection, conditions: [{ control: { role: "textbox" } }] } },
    { collection: { ...selection, conditions: [{ control: { role: "checkbox" }, checked: "yes" }] } },
    { collection: selection, text: "old item" },
    { collection: selection, nth: 0 },
    { collection: selection, selector: "#old" },
  ])("rejects invalid or ambiguous persisted data: %j", invalid => {
    expect(() => validateCollectionTarget(invalid as Target)).toThrow(CollectionSelectionError);
  });
  it("rejects runtime accessors before invoking them", () => {
    const getter = vi.fn(() => selection);
    const bad = Object.defineProperty({}, "collection", { enumerable: true, get: getter });
    expect(() => validateCollectionTarget(bad)).toThrow("unsupported fields");
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects condition-array accessors before invoking them", () => {
    const authored = target();
    const getter = vi.fn(() => selection.conditions![0]);
    Object.defineProperty(authored.collection!.conditions, "0", { enumerable: true, get: getter });
    expect(() => validateCollectionTarget(authored)).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([
    ["sparse", (entries: unknown[]) => { delete entries[0]; }],
    ["extra field", (entries: unknown[]) => { Object.assign(entries, { ref: "runtime-ref" }); }],
    ["symbol", (entries: unknown[]) => { Object.assign(entries, { [Symbol("extra")]: true }); }],
    ["non-enumerable entry", (entries: unknown[]) => { Object.defineProperty(entries, "0", { enumerable: false }); }],
  ] as const)("rejects a %s declaration array", (_label, change) => {
    const authored = target();
    change(authored.collection!.conditions!);
    expect(() => validateCollectionTarget(authored)).toThrow(expect.objectContaining({ code: "invalid" }));
  });
});

describe("selection from driver facts", () => {
  it("selects the declared member independently of matching names and model ranking", async () => {
    const authored = target();
    authored.collection!.index = 1;
    expect(await resolveCollectionTarget(driver(), authored)).toEqual({ target: { text: "Open", role: "button" }, ref: "ref-1" });
  });
  it("does not let a provider mutate the author's selection or the expected conditions", async () => {
    const d = driver();
    d.observeCollection.mockImplementation(async (spec: CollectionTarget) => {
      spec.index = 1;
      spec.conditions![0]!.value = "changed";
      return { ...observation(), conditions: [{ value: "changed" }] };
    });
    const authored = target();
    await expect(resolveCollectionTarget(d, authored)).rejects.toMatchObject({ code: "condition" });
    expect(authored.collection).toEqual(selection);
  });
  it.each([
    ["coverage", (o: CollectionObservation) => { o.complete = false; }],
    ["count", (o: CollectionObservation) => { o.items.pop(); }],
    ["position", (o: CollectionObservation) => { o.items[0]!.position = 2; }],
    ["duplicate-ref", (o: CollectionObservation) => { o.items[1]!.target!.ref = "ref-0"; }],
    ["missing-ref", (o: CollectionObservation) => { delete o.items[0]!.target!.ref; }],
    ["missing-action", (o: CollectionObservation) => { delete o.items[0]!.target; }],
    ["wrong-role", (o: CollectionObservation) => { o.items[0]!.target!.role = "link"; }],
    ["wrong-name", (o: CollectionObservation) => { o.items[0]!.target!.name = "Open another"; }],
    ["invalid-disabled", (o: CollectionObservation) => { o.items[0]!.target!.disabled = "true" as unknown as boolean; }],
    ["invalid-occluded", (o: CollectionObservation) => { o.items[0]!.target!.occluded = 1 as unknown as boolean; }],
    ["missing-condition", (o: CollectionObservation) => { o.conditions = []; }],
  ] as const)("refuses incomplete %s without substituting another item", async (_name, change) => {
    const facts = observation(); change(facts);
    await expect(resolveCollectionTarget(driver(facts), target())).rejects.toMatchObject({ code: "incomplete", kind: "handler" });
  });
  it.each(["member", "action"])("refuses a disabled %s", async kind => {
    const facts = observation();
    if (kind === "member") facts.items[0]!.disabled = true;
    else facts.items[0]!.target!.disabled = true;
    await expect(resolveCollectionTarget(driver(facts), target())).rejects.toMatchObject({ code: "disabled" });
  });
  it("does not require the previous member to have a usable action", async () => {
    const facts = observation(); delete facts.items[0]!.target;
    const authored = target(); authored.collection!.index = 1;
    await expect(resolveCollectionTarget(driver(facts), authored)).resolves.toMatchObject({ ref: "ref-1" });
  });
  it("refuses absent positions and reports unsupported drivers distinctly", async () => {
    const authored = target(); authored.collection!.index = 2;
    await expect(resolveCollectionTarget(driver(), authored)).rejects.toMatchObject({ code: "missing" });
    await expect(resolveCollectionTarget(new StubDriver(), target())).rejects.toMatchObject({ code: "unsupported", kind: "handler" });
  });
  it("classifies a truthy nonfunction capability as unsupported evidence", async () => {
    const malformed = Object.assign(new StubDriver(), { observeCollection: 42 }) as unknown as Driver;
    await expect(resolveCollectionTarget(malformed, target())).rejects.toMatchObject({ code: "unsupported", kind: "handler" });
  });
  it("cannot substitute a neighboring ref through a changing accessor", async () => {
    const facts = observation();
    let reads = 0;
    const getter = vi.fn(() => ++reads < 4 ? "ref-0" : "ref-1");
    Object.defineProperty(facts.items[0]!.target, "ref", { enumerable: true, get: getter });
    const d = driver(facts);
    const click = vi.spyOn(d, "click");
    await expect(new BuiltinStepHandler().execute({ kind: "click", target: target() }, d))
      .rejects.toMatchObject({ code: "incomplete", kind: "handler" });
    expect(getter).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });
  it.each(["envelope", "member", "action", "control"] as const)("rejects relevant %s observation accessors without invoking them", async location => {
    const facts = observation();
    const [object, key, value] = location === "envelope" ? [facts, "complete", true]
      : location === "member" ? [facts.items[0]!, "target", facts.items[0]!.target]
      : location === "action" ? [facts.items[0]!.target!, "disabled", false]
      : [facts.conditions[0]!, "value", "books"];
    const getter = vi.fn(() => value);
    Object.defineProperty(object, key, { enumerable: true, get: getter });
    await expect(resolveCollectionTarget(driver(facts), target())).rejects.toMatchObject({ code: "incomplete" });
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(["items", "conditions"] as const)("requires dense own data in observed %s arrays", async key => {
    for (const shape of ["accessor", "sparse", "extra"] as const) {
      const facts = observation();
      const entries = facts[key];
      const value = entries[0];
      const getter = vi.fn(() => value);
      if (shape === "accessor") Object.defineProperty(entries, "0", { enumerable: true, get: getter });
      else if (shape === "sparse") delete entries[0];
      else Object.assign(entries, { extra: true });
      await expect(resolveCollectionTarget(driver(facts), target())).rejects.toMatchObject({ code: "incomplete", kind: "handler" });
      expect(getter).not.toHaveBeenCalled();
    }
  });
  it("ignores harmless extra PageElement metadata without evaluating it", async () => {
    const facts = observation();
    Object.assign(facts.items[0]!.target!, { clickable: true, value: "metadata", checked: false });
    const getter = vi.fn(() => "adapter detail");
    Object.defineProperty(facts.items[0]!.target, "adapterDetail", { enumerable: true, get: getter });
    await expect(resolveCollectionTarget(driver(facts), target())).resolves.toMatchObject({ ref: "ref-0" });
    expect(getter).not.toHaveBeenCalled();
  });
  it("does not echo captured query values in diagnostics", async () => {
    const facts = observation(); facts.conditions[0]!.value = "private query value";
    const error = await resolveCollectionTarget(driver(facts), target()).catch(error => error);
    expect(error).toMatchObject({ code: "condition" });
    expect(error.message).not.toContain("private query value");
  });
  it("checks false and mixed conditions without treating them as absent", async () => {
    const authored = target();
    authored.collection!.conditions = [{ control: { role: "checkbox", name: "Filter" }, checked: "mixed", disabled: false }];
    const facts = observation(); facts.conditions = [{ checked: "mixed", disabled: false }];
    await expect(resolveCollectionTarget(driver(facts), authored)).resolves.toMatchObject({ ref: "ref-0" });
    facts.conditions[0]!.disabled = true;
    await expect(resolveCollectionTarget(driver(facts), authored)).rejects.toMatchObject({ code: "condition" });
  });
});

it.each(["click", "doubleClick", "hover", "type", "select"] as const)("dispatches %s to the exact ref without changing the persisted target", async kind => {
  const d = driver();
  const action = vi.spyOn(d, kind).mockResolvedValue();
  const authored: Step = kind === "type" ? { kind, target: target(), text: "input" }
    : kind === "select" ? { kind, target: target(), value: "option" } : { kind, target: target() };
  const original = JSON.stringify(authored);
  await new BuiltinStepHandler().execute(authored, d);
  expect(d.observeCollection).toHaveBeenCalledTimes(1);
  expect(action).toHaveBeenCalledTimes(1);
  expect(action.mock.calls[0]![0]).toEqual({ text: "Open", role: "button" });
  expect(action.mock.calls[0]!.at(-1)).toBe("ref-0");
  expect(JSON.stringify(authored)).toBe(original);
});

it("does not dispatch after cancellation during budgeted collection observation", async () => {
  const d = driver();
  const action = vi.spyOn(d, "click");
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  d.observeCollection.mockImplementation(async () => {
    await new Promise<void>(resolve => { release = resolve; started(); });
    return observation();
  });
  const caller = new AbortController();
  const reason = new Error("cancel collection capture");
  const pending = runHarness({ driver: d, context: { provide: async () => ({ intent: "open first" }) },
    planner: { plan: async () => ({ name: "first", steps: [{ kind: "click", target: target() }], assertions: [] }) },
    critic: { judge: async () => ({ passed: true, results: [] }) }, reporter: { emit: async () => {} },
  }, "first", { budget: { maxModelCalls: 0 }, signal: caller.signal });
  const checked = expect(pending).rejects.toBe(reason);
  await ready; caller.abort(reason); release();
  await checked;
  expect(action).not.toHaveBeenCalled();
});

it("rejects a late collection observation after its execution deadline without dispatch", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  try {
    const d = driver();
    const action = vi.spyOn(d, "click");
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    d.observeCollection.mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve; started(); });
      return observation();
    });
    const pending = runHarness({ driver: d, context: { provide: async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      return { intent: "open first" };
    } },
      planner: { plan: async () => ({ name: "first", steps: [{ kind: "click", target: target() }], assertions: [] }) },
      critic: { judge: async () => ({ passed: true, results: [] }) }, reporter: { emit: async () => {} },
    }, "first", { budget: { timeoutMs: 10 } });
    await ready;
    await vi.advanceTimersByTimeAsync(20);
    expect(action).not.toHaveBeenCalled();
    // Cancellation is cooperative: drain the admitted observation, but reject its late value.
    release();
    const result = await pending;
    expect(result.verdict).toMatchObject({ passed: false, failure: "budget", budget: { limit: "time" } });
    expect(action).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
