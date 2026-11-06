import { describe, expect, it, vi } from "vitest";
import { CollectionSelectionError, resolveChoiceValues, resolveCollectionTarget,
  SelectionNotDispatchedError, validateCollectionTarget } from "../src/core/collection.js";
import type { CollectionChoice, CollectionObservation, CollectionTarget, Target } from "../src/core/types.js";
import { StubDriver } from "./support/doubles.js";

const choice = (): CollectionChoice => ({ version: 1, cardinality: 1, policy: "first-dom",
  identity: { kind: "attribute", scope: "item", attribute: "data-resource-id" },
  where: [{ kind: "attribute-equals", scope: "item", attribute: "data-available", value: "true" }],
  maxReselections: 1,
});
const selection = (): CollectionTarget => ({ root: { role: "list", name: "Catalog" },
  itemRole: "listitem", target: { role: "button", name: "Add" }, order: "dom", expectedCount: 3,
  choice: choice(),
});
const target = (): Target => ({ collection: selection() });
const observation = (): CollectionObservation => ({ complete: true, order: "dom", conditions: [],
  items: ["A", "B", "C"].map((key, position) => ({ position, disabled: false,
    target: { role: "button", name: "Add", ref: `ref-${key}`, disabled: false, occluded: false },
    choice: { complete: true, key, values: [position === 0 ? "false" : "true"] },
  })),
});
function driver(facts = observation(), values: readonly string[] = ["true"]) {
  return Object.assign(new StubDriver(), {
    observeCollection: vi.fn(async (_selection: CollectionTarget) => facts),
    [resolveChoiceValues]: vi.fn(async (_selection: CollectionTarget) => values),
  });
}

describe("explicit collection choice declarations", () => {
  it("copies every predicate and identity without adding positional meaning", () => {
    const authored = target();
    const copy = validateCollectionTarget(authored);
    expect(copy).toEqual(authored.collection);
    expect(copy).not.toBe(authored.collection);
    expect(copy.choice!.identity).not.toBe(authored.collection!.choice!.identity);
    expect(copy.choice!.where[0]).not.toBe(authored.collection!.choice!.where[0]);
    expect("index" in copy).toBe(false);
  });

  it.each([
    ["mixed index", (t: any) => { t.collection.index = 0; }],
    ["undefined index", (t: any) => { t.collection.index = undefined; }],
    ["no selection", (t: any) => { delete t.collection.choice; }],
    ["legacy locator", (t: any) => { t.text = "Add"; }],
    ["version", (t: any) => { t.collection.choice.version = 2; }],
    ["cardinality", (t: any) => { t.collection.choice.cardinality = 2; }],
    ["ranking policy", (t: any) => { t.collection.choice.policy = "cheapest"; }],
    ["missing allowance", (t: any) => { delete t.collection.choice.maxReselections; }],
    ["excessive allowance", (t: any) => { t.collection.choice.maxReselections = 2; }],
    ["missing identity", (t: any) => { delete t.collection.choice.identity; }],
    ["inferred identity", (t: any) => { t.collection.choice.identity.kind = "text"; }],
    ["identity scope", (t: any) => { t.collection.choice.identity.scope = "page"; }],
    ["identity attribute", (t: any) => { t.collection.choice.identity.attribute = "id"; }],
    ["oversized attribute", (t: any) => { t.collection.choice.identity.attribute = `data-${"x".repeat(124)}`; }],
    ["empty predicates", (t: any) => { t.collection.choice.where = []; }],
    ["too many predicates", (t: any) => { t.collection.choice.where = Array(17).fill(t.collection.choice.where[0]); }],
    ["predicate kind", (t: any) => { t.collection.choice.where[0].kind = "contains"; }],
    ["predicate scope", (t: any) => { t.collection.choice.where[0].scope = "page"; }],
    ["predicate attribute", (t: any) => { t.collection.choice.where[0].attribute = "value"; }],
    ["blank expectation", (t: any) => { t.collection.choice.where[0].value = " "; }],
    ["oversized expectation", (t: any) => { t.collection.choice.where[0].value = "x".repeat(257); }],
    ["non-string expectation", (t: any) => { t.collection.choice.where[0].value = true; }],
    ["unknown field", (t: any) => { t.collection.choice.fallback = "similar"; }],
  ])("rejects %s without interpreting it as a locator", (_name, change) => {
    const authored = target(); change(authored);
    expect(() => validateCollectionTarget(authored)).toThrow(expect.objectContaining({ code: "invalid" }));
  });

  it("rejects accessors and sparse predicate arrays without invoking them", () => {
    const authored = target(), getter = vi.fn(() => "true");
    Object.defineProperty(authored.collection!.choice!.where[0], "value", { get: getter, enumerable: true });
    expect(() => validateCollectionTarget(authored)).toThrow(CollectionSelectionError);
    expect(getter).not.toHaveBeenCalled();
    const sparse = target(); delete sparse.collection!.choice!.where[0];
    expect(() => validateCollectionTarget(sparse)).toThrow(CollectionSelectionError);
  });

  it("accepts only a same-identity reference with no reselection allowance", () => {
    const authored = target(), c = authored.collection!.choice!;
    c.maxReselections = 0;
    c.where = [{ kind: "attribute-equals", scope: "item", attribute: "data-resource-id", value: { bindingId: "added-item" } }];
    expect(validateCollectionTarget(authored)).toEqual(authored.collection);
    c.maxReselections = 1;
    expect(() => validateCollectionTarget(authored)).toThrow("no reselection");
    c.maxReselections = 0; c.where[0]!.scope = "action";
    expect(() => validateCollectionTarget(authored)).toThrow("identity attribute");
    c.where[0]!.scope = "item"; c.where[0]!.attribute = "data-other-id";
    expect(() => validateCollectionTarget(authored)).toThrow("identity attribute");
  });

  it("rejects mixed binding references and invalid IDs", () => {
    const authored = target(), c = authored.collection!.choice!;
    c.maxReselections = 0;
    c.where = ["first", "second"].map(bindingId => ({ kind: "attribute-equals", scope: "item",
      attribute: "data-resource-id", value: { bindingId } }));
    expect(() => validateCollectionTarget(authored)).toThrow("one binding ID");
    c.where = [c.where[0]!]; c.where[0]!.value = { bindingId: "bad id" };
    expect(() => validateCollectionTarget(authored)).toThrow("binding ID");
  });
});

describe("deterministic selection from complete choice facts", () => {
  it("selects the first eligible DOM member, not the old first item or an arbitrary duplicate label", async () => {
    expect(await resolveCollectionTarget(driver(), target()))
      .toEqual({ target: { text: "Add", role: "button" }, ref: "ref-B" });
  });

  it.each(["member", "action", "occluded"])("skips an explicitly unavailable %s among matching candidates", async kind => {
    const facts = observation();
    if (kind === "member") facts.items[1]!.disabled = true;
    else if (kind === "action") facts.items[1]!.target!.disabled = true;
    else facts.items[1]!.target!.occluded = true;
    expect((await resolveCollectionTarget(driver(facts), target())).ref).toBe("ref-C");
  });

  it("requires every predicate and uses exact string equality", async () => {
    const authored = target(), facts = observation();
    authored.collection!.choice!.where.push({ kind: "attribute-equals", scope: "action", attribute: "data-ready", value: "ready" });
    for (const item of facts.items) item.choice!.values!.push(item.position === 1 ? "ready " : "ready");
    expect((await resolveCollectionTarget(driver(facts, ["true", "ready"]), authored)).ref).toBe("ref-C");
  });

  it("rejects a predicate observation that contradicts the identity read from the same attribute", async () => {
    const authored = target(), facts = observation();
    authored.collection!.choice!.where = [{ kind: "attribute-equals", scope: "item", attribute: "data-resource-id", value: "B" }];
    for (const item of facts.items) item.choice!.values = [item.choice!.key!];
    facts.items[2]!.choice!.values = ["B"];
    await expect(resolveCollectionTarget(driver(facts, ["B"]), authored)).rejects.toMatchObject({ code: "incomplete" });
  });

  it("rejects inconsistent repeated predicate facts even on a candidate that would be skipped", async () => {
    const authored = target(), facts = observation();
    authored.collection!.choice!.where.push({ ...authored.collection!.choice!.where[0]! });
    for (const item of facts.items) item.choice!.values!.push("true");
    await expect(resolveCollectionTarget(driver(facts, ["true", "true"]), authored)).rejects.toMatchObject({ code: "incomplete" });
  });

  it("preserves repeated declared predicates when their observed values agree", async () => {
    const authored = target(), facts = observation();
    authored.collection!.choice!.where.push({ ...authored.collection!.choice!.where[0]! });
    for (const item of facts.items) item.choice!.values!.push(item.choice!.values![0]!);
    const before = JSON.stringify(authored);
    expect((await resolveCollectionTarget(driver(facts, ["true", "true"]), authored)).ref).toBe("ref-B");
    expect(JSON.stringify(authored)).toBe(before);
    expect(authored.collection!.choice!.where).toHaveLength(2);
  });

  it("does not observe before the session authorizes a choice", async () => {
    const d = Object.assign(new StubDriver(), { observeCollection: vi.fn(async () => observation()) });
    await expect(resolveCollectionTarget(d, target())).rejects.toMatchObject({ code: "unsupported" });
    expect(d.observeCollection).not.toHaveBeenCalled();
  });

  it.each([[], ["false"], ["true", "extra"], [" "], ["x".repeat(257)]].map(values => ({ values })))
  ("rejects changed or incomplete private expectations $values", async ({ values }) => {
    const d = driver(observation(), values);
    await expect(resolveCollectionTarget(d, target())).rejects.toMatchObject({ code: "incomplete" });
    expect(d.observeCollection).not.toHaveBeenCalled();
  });

  it("resolves a binding privately without mutating or leaking it into the authored target", async () => {
    const authored = target(), c = authored.collection!.choice!;
    c.maxReselections = 0;
    c.where = [{ kind: "attribute-equals", scope: "item", attribute: "data-resource-id", value: { bindingId: "added-item" } }];
    const facts = observation();
    for (const item of facts.items) item.choice!.values = [item.choice!.key!];
    const before = JSON.stringify(authored), d = driver(facts, ["B"]);
    expect((await resolveCollectionTarget(d, authored)).ref).toBe("ref-B");
    expect(d.observeCollection.mock.calls[0]![0].choice!.where[0]!.value).toBe("B");
    expect(JSON.stringify(authored)).toBe(before);
    expect(authored.collection!.choice!.where[0]!.value).toEqual({ bindingId: "added-item" });
  });

  it("does not let a session or adapter mutate the expectations while capturing", async () => {
    const authored = target(), d = driver();
    d[resolveChoiceValues].mockImplementation(async selection => {
      selection.choice!.where[0]!.value = "false";
      return ["true"];
    });
    d.observeCollection.mockImplementation(async selection => {
      selection.choice!.where[0]!.value = "false";
      return observation();
    });
    expect((await resolveCollectionTarget(d, authored)).ref).toBe("ref-B");
    expect(authored.collection!.choice!.where[0]!.value).toBe("true");
  });

  it.each([
    ["missing choice", (o: CollectionObservation) => { delete o.items[0]!.choice; }],
    ["incomplete fact", (o: CollectionObservation) => { o.items[0]!.choice!.complete = false; }],
    ["missing identity", (o: CollectionObservation) => { delete o.items[0]!.choice!.key; }],
    ["blank identity", (o: CollectionObservation) => { o.items[0]!.choice!.key = " "; }],
    ["oversized identity", (o: CollectionObservation) => { o.items[0]!.choice!.key = "x".repeat(257); }],
    ["missing predicates", (o: CollectionObservation) => { delete o.items[0]!.choice!.values; }],
    ["incomplete predicates", (o: CollectionObservation) => { o.items[0]!.choice!.values = []; }],
    ["extra predicates", (o: CollectionObservation) => { o.items[0]!.choice!.values!.push("extra"); }],
    ["blank predicate", (o: CollectionObservation) => { o.items[0]!.choice!.values = [""]; }],
    ["oversized predicate", (o: CollectionObservation) => { o.items[0]!.choice!.values = ["x".repeat(257)]; }],
    ["unknown member state", (o: CollectionObservation) => { delete o.items[0]!.disabled; }],
    ["unknown action state", (o: CollectionObservation) => { delete o.items[0]!.target!.disabled; }],
    ["unknown visibility", (o: CollectionObservation) => { delete o.items[0]!.target!.occluded; }],
    ["wrong action role", (o: CollectionObservation) => { o.items[0]!.target!.role = "link"; }],
    ["wrong action name", (o: CollectionObservation) => { o.items[0]!.target!.name = "Other"; }],
    ["incomplete membership", (o: CollectionObservation) => { o.complete = false; }],
    ["missing member", (o: CollectionObservation) => { o.items.pop(); }],
  ])("does not skip an uncertain candidate: %s", async (_name, change) => {
    const facts = observation(); change(facts);
    await expect(resolveCollectionTarget(driver(facts), target())).rejects.toMatchObject({ code: "incomplete" });
  });

  it("refuses duplicate identities even when the earlier duplicate fails the predicate", async () => {
    const facts = observation(); facts.items[0]!.choice!.key = "B";
    await expect(resolveCollectionTarget(driver(facts), target())).rejects.toMatchObject({ code: "ambiguous" });
  });

  it("does not skip an eligible member whose action is ambiguous or absent", async () => {
    const facts = observation(); delete facts.items[1]!.target;
    await expect(resolveCollectionTarget(driver(facts), target())).rejects.toMatchObject({ code: "incomplete" });
  });

  it("does not authorize a fallback when no candidate matches", async () => {
    const facts = observation(); for (const item of facts.items) item.choice!.values = ["false"];
    await expect(resolveCollectionTarget(driver(facts), target())).rejects.toMatchObject({ code: "missing" });
  });

  it("preserves position semantics and needs no choice authorization for a positional target", async () => {
    const authored = target(), { choice: _choice, ...scope } = authored.collection!;
    authored.collection = { ...scope, index: 0 };
    const facts = observation(); facts.items[0]!.disabled = true;
    const d = driver(facts);
    await expect(resolveCollectionTarget(d, authored)).rejects.toMatchObject({ code: "disabled" });
    expect(d[resolveChoiceValues]).not.toHaveBeenCalled();
  });

  it("does not consume unrelated choice metadata on legacy positional observations", async () => {
    const authored = target(), { choice: _choice, ...scope } = authored.collection!;
    authored.collection = { ...scope, index: 0 };
    const facts = observation(), getter = vi.fn(() => { throw new Error("unrelated metadata"); });
    Object.defineProperty(facts.items[0], "choice", { get: getter, enumerable: true });
    expect((await resolveCollectionTarget(driver(facts), authored)).ref).toBe("ref-A");
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not invoke accessors in consumed observation facts", async () => {
    const facts = observation(), getter = vi.fn(() => "A");
    Object.defineProperty(facts.items[0]!.choice, "key", { get: getter, enumerable: true });
    await expect(resolveCollectionTarget(driver(facts), target())).rejects.toMatchObject({ code: "incomplete" });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["expectations", "observations"])("rejects accessor entries in %s without reading them", async kind => {
    const facts = observation(), values = ["true"], getter = vi.fn(() => "true");
    Object.defineProperty(values, "0", { get: getter, enumerable: true });
    if (kind === "observations") facts.items[0]!.choice!.values = values;
    const d = driver(facts, kind === "expectations" ? values : ["true"]);
    await expect(resolveCollectionTarget(d, target())).rejects.toMatchObject({ code: "incomplete" });
    expect(getter).not.toHaveBeenCalled();
    if (kind === "expectations") expect(d.observeCollection).not.toHaveBeenCalled();
  });

  it("marks a proven pre-dispatch refusal separately from a generic stale error", () => {
    const refused = new SelectionNotDispatchedError("runtime-ref");
    expect(refused).toBeInstanceOf(CollectionSelectionError);
    expect(refused).toMatchObject({ ref: "runtime-ref", code: "stale", kind: "resolution" });
    expect(new CollectionSelectionError("stale", "changed")).not.toBeInstanceOf(SelectionNotDispatchedError);
  });
});
