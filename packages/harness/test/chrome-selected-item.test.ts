import { createContext, runInContext } from "node:vm";
import { expect, test } from "vitest";
import { prepareSelectedItemReceipt, resourceKeyScript } from "../src/adapters/drivers/chrome-selected-item.js";
import { ChromeDevToolsDriver } from "../src/adapters/drivers/chrome.js";

class Node {
  isConnected = true;
  parentElement?: Node;
  children: Node[] = [];
  attrs = new Map<string, string>();
  value?: string;
  disabled = false;
  ariaOwnsElements?: Node[];
  shadowRoot?: { nodes: Node[] };
  tagName = "DIV";
  constructor(readonly id: string, private readonly document: object) {}
  getRootNode() { return this.document; }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string) { return this.attrs.has(name); }
  contains(node: Node): boolean { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector: string) {
    if (selector === ":disabled") return this.disabled;
    if (selector === "input[type=checkbox],input[type=radio]") return false;
    if (selector === "[") throw new Error("invalid selector");
    return selector === "*" || selector === `#${this.id}`;
  }
}

function fixture() {
  const document = { getElementById: (id: string): Node | undefined => all.find(node => node.id === id),
    createTreeWalker: (tree: unknown, _what: unknown) => {
    const nodes = tree === document ? all : (tree as { nodes?: Node[] }).nodes ?? [];
    let index = 0;
    return { nextNode: () => nodes[index++] ?? null };
  } };
  const root = new Node("list", document), item = new Node("item", document), action = new Node("action", document);
  const condition = new Node("filter", document), destination = new Node("detail", document);
  root.children = [item]; item.children = [action]; item.parentElement = root; action.parentElement = item;
  item.attrs.set("data-resource-key", "B"); action.attrs.set("data-action-key", "action-B");
  destination.attrs.set("data-resource-key", "B"); condition.value = "active";
  const all = [root, item, action, condition, destination];
  const queue: unknown[] = [];
  const saved = { root, members: [item], actions: [action], conditions: [condition], conditionFacts: [{ disabled: false, value: "active" }] };
  const state = { records: [] as unknown[], collections: new Map([["collection:test", saved]]), overflow: false,
    observer: { takeRecords: () => queue.splice(0) }, retain(records: unknown[]) { this.records.push(...records); } };
  const listeners = new Set<(event: unknown) => void>();
  const eventTypes = new Map<(event: unknown) => void, string>();
  const context = createContext({ document, NodeFilter: { SHOW_ELEMENT: 1 },
    addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.add(listener); eventTypes.set(listener, type); },
    removeEventListener: (_: string, listener: (event: unknown) => void) => { listeners.delete(listener); eventTypes.delete(listener); },
  });
  runInContext("window = globalThis; top = window", context);
  context.state = state;
  runInContext('globalThis[Symbol.for("guard:test")] = state', context);
  let calls = 0;
  const call = async (_name: string, args: Record<string, unknown> = {}) => {
    calls++;
    const uids = (args.args ?? []) as string[];
    return JSON.stringify(runInContext(`(${String(args.function)})`, context)(...uids.map(() => action)));
  };
  const prepare = (scope: "item" | "action" = "item", attribute = "data-resource-key") =>
    prepareSelectedItemReceipt(call, "guard:test", "collection:test", "uid", { kind: "attribute", scope, attribute });
  const click = (target = action, trusted = true) => {
    for (const listener of [...listeners]) if (eventTypes.get(listener) === "click") listener({ isTrusted: trusted, composedPath: () => [target] });
  };
  const pagehide = () => {
    for (const listener of [...listeners]) if (eventTypes.get(listener) === "pagehide") listener({ persisted: true });
  };
  const receiptCount = () => runInContext("Object.getOwnPropertySymbols(globalThis).filter(s => s.description?.startsWith('cairn-selected-item:')).length", context) as number;
  const read = (selector = "#detail", attribute = "data-resource-key") => runInContext(`(${resourceKeyScript({ kind: "attribute", selector, attribute })})`, context)();
  return { prepare, click, pagehide, receiptCount, read, call, context, state, root, item, action, condition, destination, all, queue, listeners, calls: () => calls };
}

test("selected member key is captured before the matching trusted click and survives SPA removal", async () => {
  const f = fixture(), receipt = await f.prepare();
  f.click();
  // The action consequence can remove the source; the accepted pre-action key remains B.
  f.item.isConnected = false;
  f.item.attrs.set("data-resource-key", "C");
  expect(await receipt.finish()).toEqual({ complete: true, value: "B" });
  expect(f.listeners.size).toBe(0);
  const calls = f.calls();
  await receipt.dispose();
  expect(f.calls()).toBe(calls);
});

test("action-scoped extraction does not borrow the member's key", async () => {
  const f = fixture(), receipt = await f.prepare("action", "data-action-key");
  f.click();
  expect(await receipt.finish()).toEqual({ complete: true, value: "action-B" });
});

test.each(["changed-key", "changed-key-reverted", "control-property", "removed", "disabled", "new-guard", "overflow"])(
  "a %s before dispatch cannot confirm the old binding", async change => {
    const f = fixture(), receipt = await f.prepare();
    if (change === "changed-key") f.item.attrs.set("data-resource-key", "C");
    if (change === "changed-key-reverted") f.queue.push({ type: "attributes", target: f.item });
    if (change === "control-property") f.condition.value = "other";
    if (change === "removed") f.item.isConnected = false;
    if (change === "disabled") f.action.disabled = true;
    if (change === "new-guard") runInContext('globalThis[Symbol.for("guard:test")] = {}', f.context);
    if (change === "overflow") f.state.overflow = true;
    f.click();
    expect(await receipt.finish()).toEqual({ complete: false });
    expect(f.listeners.size).toBe(0);
  },
);

test("property-only incoming ARIA ownership changes after preparation invalidate the receipt", async () => {
  const f = fixture(), receipt = await f.prepare();
  f.destination.ariaOwnsElements = [f.item];
  f.click();
  expect(await receipt.finish()).toEqual({ complete: false });
});

test.each(["root", "condition", "action"] as const)("property-only outgoing ARIA ownership on %s invalidates the receipt", async owner => {
  const f = fixture(), receipt = await f.prepare();
  f[owner].ariaOwnsElements = [f.destination];
  f.click();
  expect(await receipt.finish()).toEqual({ complete: false });
});

test("unrelated outgoing ARIA ownership does not invalidate the selected collection", async () => {
  const f = fixture(), receipt = await f.prepare();
  f.destination.ariaOwnsElements = [new Node("external", f.context.document as object)];
  f.click();
  expect(await receipt.finish()).toEqual({ complete: true, value: "B" });
});

test.each(["root", "item", "action"] as const)("a new open shadow root on %s without a mutation invalidates the receipt", async owner => {
  const f = fixture(), receipt = await f.prepare();
  f[owner].shadowRoot = { nodes: [] };
  expect(f.queue).toEqual([]);
  f.click();
  expect(await receipt.finish()).toEqual({ complete: false });
  expect(f.listeners.size).toBe(0);
});

test("a shadow root outside the selected collection does not invalidate the receipt", async () => {
  const f = fixture(), receipt = await f.prepare();
  f.destination.shadowRoot = { nodes: [] };
  f.click();
  expect(await receipt.finish()).toEqual({ complete: true, value: "B" });
});

test.each(["root", "item", "condition"] as const)("reverted incoming aria-owns targeting %s invalidates the receipt", async target => {
  const f = fixture(), receipt = await f.prepare();
  // Both records belong to an outside owner; its current attribute is already absent.
  f.queue.push({ type: "attributes", target: f.destination, attributeName: "aria-owns", oldValue: null },
    { type: "attributes", target: f.destination, attributeName: "aria-owns", oldValue: f[target].id });
  f.click();
  expect(await receipt.finish()).toEqual({ complete: false });
  expect(f.listeners.size).toBe(0);
});

test.each(["detail", "missing"])("reverted aria-owns with unrelated or unresolved target %s does not invalidate the receipt", async id => {
  const f = fixture(), receipt = await f.prepare();
  f.queue.push({ type: "attributes", target: f.destination, attributeName: "aria-owns", oldValue: id });
  f.click();
  expect(await receipt.finish()).toEqual({ complete: true, value: "B" });
});

test("old aria-owns targets resolve in the outside owner's tree scope", async () => {
  const f = fixture(), receipt = await f.prepare();
  const tree = { getElementById: (_id: string) => undefined };
  const owner = new Node("shadow-owner", tree);
  f.queue.push({ type: "attributes", target: owner, attributeName: "aria-owns", oldValue: f.item.id });
  f.click();
  expect(await receipt.finish()).toEqual({ complete: true, value: "B" });
});

test.each(["x".repeat(65537), "x ".repeat(8192) + "y ".repeat(8192)])("oversized reverted ARIA ownership cannot confirm continuity", async oldValue => {
  const f = fixture(), receipt = await f.prepare();
  f.queue.push({ type: "attributes", target: f.destination, attributeName: "aria-owns", oldValue });
  f.click();
  expect(await receipt.finish()).toEqual({ complete: false });
});

test.each(["absent", "untrusted", "wrong-target", "navigation"])("%s click receipt remains unavailable", async situation => {
  const f = fixture(), receipt = await f.prepare();
  if (situation === "untrusted") f.click(f.action, false);
  if (situation === "wrong-target") f.click(f.destination);
  if (situation === "navigation") {
    f.click();
    f.context.document = {};
  }
  expect(await receipt.finish()).toEqual({ complete: false });
  expect(f.listeners.size).toBe(0);
});

test.each(["", " ", "x".repeat(257)])("empty or oversized source values do not create receipts", async value => {
  const f = fixture();
  f.item.attrs.set("data-resource-key", value);
  const receipt = await f.prepare();
  f.click();
  expect(await receipt.finish()).toEqual({ complete: false });
  expect(f.listeners.size).toBe(0);
});

test("a pre-existing collection mutation cannot create a receipt", async () => {
  const f = fixture();
  f.queue.push({ type: "attributes", target: f.item });
  const receipt = await f.prepare();
  f.click();
  expect(await receipt.finish()).toEqual({ complete: false });
});

test.each(["stamp", "excluded", "unsupported"])("host ownership %s changes cannot confirm a receipt", async change => {
  const f = fixture();
  const ownership = { stamp: "initial", unsupported: false, excluded: false };
  f.context.hostRegistry = { document: f.context.document, status: () => ownership, excluded: () => ownership.excluded };
  runInContext('globalThis[Symbol.for("host:test")] = hostRegistry', f.context);
  const receipt = await prepareSelectedItemReceipt(f.call, "guard:test", "collection:test", "uid",
    { kind: "attribute", scope: "item", attribute: "data-resource-key" }, "host:test", "initial");
  if (change === "stamp") ownership.stamp = "changed";
  if (change === "excluded") ownership.excluded = true;
  if (change === "unsupported") ownership.unsupported = true;
  f.click();
  expect(await receipt.finish()).toEqual({ complete: false });
});

test("an interrupted prepare response removes an already installed listener", async () => {
  const f = fixture();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await f.call(name, args);
    if (String(args.function).includes("window.addEventListener")) throw new Error("response interrupted");
    return result;
  };
  await expect(prepareSelectedItemReceipt(call, "guard:test", "collection:test", "uid",
    { kind: "attribute", scope: "item", attribute: "data-resource-key" })).rejects.toThrow("response interrupted");
  expect(f.listeners.size).toBe(0);
});

test("independent destination reads require one bounded explicit data attribute", () => {
  const f = fixture();
  expect(f.read()).toEqual({ complete: true, value: "B" });
  expect(f.read("#absent")).toEqual({ complete: false });
  expect(f.read("*")).toEqual({ complete: false });
  expect(f.read("[")).toEqual({ complete: false });
  expect(f.read("#detail", "value")).toEqual({ complete: false });
  f.destination.attrs.set("data-resource-key", "C");
  expect(f.read()).toEqual({ complete: true, value: "C" });
  f.destination.attrs.set("data-resource-key", "x".repeat(257));
  expect(f.read()).toEqual({ complete: false });
});

test("destination traversal exceeding the node bound is unavailable even with a unique early match", () => {
  const f = fixture();
  while (f.all.length < 16385) f.all.push(f.item);
  expect(f.read()).toEqual({ complete: false });
});

test("host-owned destination nodes are not resource evidence", () => {
  const f = fixture();
  f.context.hostRegistry = { document: f.context.document, status: () => ({ stamp: "initial", unsupported: false }), excluded: () => true };
  runInContext('globalThis[Symbol.for("host:test")] = hostRegistry', f.context);
  const result = runInContext(`(${resourceKeyScript({ kind: "attribute", selector: "#detail", attribute: "data-resource-key" }, "host:test")})`, f.context)();
  expect(result).toEqual({ complete: false });
});

test.each([false, true])("driver dispatches once and cleans up the receipt (click failure=%s)", async fail => {
  const f = fixture(), driver = new ChromeDevToolsDriver();
  const internal = driver as unknown as {
    actionUid: () => Promise<string>;
    collectionObservations: Map<string, unknown>;
    call: () => Promise<string>;
    callAccepting: (name: string, args: unknown, collection: unknown, beforeFollow?: () => Promise<void>) => Promise<boolean>;
  };
  internal.actionUid = async () => "uid";
  internal.call = async () => "1: https://app/list [selected]";
  internal.collectionObservations.set("ref", { prepareSelectedItemKey: () => f.prepare() });
  let clicks = 0;
  internal.callAccepting = async (_name, _args, _collection, beforeFollow) => {
    clicks++; f.click();
    if (fail) throw new Error("dispatch interrupted");
    await beforeFollow?.();
    return false;
  };
  const result = driver.clickWithSelectedItemEvidence({ role: "link" }, "ref", { kind: "attribute", scope: "item", attribute: "data-resource-key" });
  if (fail) await expect(result).rejects.toThrow("dispatch interrupted");
  else expect(await result).toEqual({ complete: true, value: "B" });
  expect(clicks).toBe(1);
  expect(f.listeners.size).toBe(0);
});

test("a missing source key still dispatches only once and returns unavailable", async () => {
  const f = fixture(), driver = new ChromeDevToolsDriver();
  f.item.attrs.delete("data-resource-key");
  const internal = driver as unknown as {
    actionUid: () => Promise<string>;
    collectionObservations: Map<string, unknown>;
    call: () => Promise<string>;
    callAccepting: (name: string, args: unknown, collection: unknown, beforeFollow?: () => Promise<void>) => Promise<boolean>;
  };
  internal.actionUid = async () => "uid";
  internal.call = async () => "1: https://app/list [selected]";
  internal.collectionObservations.set("ref", { prepareSelectedItemKey: () => f.prepare() });
  let clicks = 0;
  internal.callAccepting = async (_name, _args, _collection, beforeFollow) => { clicks++; f.click(); await beforeFollow?.(); return false; };
  expect(await driver.clickWithSelectedItemEvidence({ role: "link" }, "ref",
    { kind: "attribute", scope: "item", attribute: "data-resource-key" })).toEqual({ complete: false });
  expect(clicks).toBe(1);
});

test.each([false, true])("pagehide removes the source document receipt before bfcache (clicked=%s)", async clicked => {
  const f = fixture(), receipt = await f.prepare();
  if (clicked) f.click();
  expect(f.receiptCount()).toBe(1);
  f.pagehide();
  expect(f.receiptCount()).toBe(0);
  expect(f.listeners.size).toBe(0);
  expect(await receipt.finish()).toEqual({ complete: false });
});

test("finish is consumed once and disposal releases its browser marker", async () => {
  const f = fixture(), receipt = await f.prepare();
  f.click();
  expect(f.receiptCount()).toBe(1);
  expect(await receipt.finish()).toEqual({ complete: true, value: "B" });
  expect(f.receiptCount()).toBe(0);
  const calls = f.calls();
  expect(await receipt.finish()).toEqual({ complete: false });
  await receipt.dispose();
  expect(f.calls()).toBe(calls);
});

test("a failed receipt read is cleaned up by disposal without another click", async () => {
  const f = fixture();
  let failRead = false;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    if (failRead && String(args.function).includes("receipt?.document")) throw new Error("read interrupted");
    return f.call(name, args);
  };
  const receipt = await prepareSelectedItemReceipt(call, "guard:test", "collection:test", "uid",
    { kind: "attribute", scope: "item", attribute: "data-resource-key" });
  f.click(); failRead = true;
  await expect(receipt.finish()).rejects.toThrow("read interrupted");
  await receipt.dispose();
  expect(f.receiptCount()).toBe(0);
  expect(f.listeners.size).toBe(0);
});
