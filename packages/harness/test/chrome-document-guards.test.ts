import { createContext, runInContext } from "node:vm";
import { expect, test } from "vitest";
import { ChromeDocumentObservation } from "../src/adapters/drivers/chrome-documents.js";
import { ChromeDevToolsDriver, parseSnapshotRows } from "../src/adapters/drivers/chrome.js";

class Node {
  isConnected = true;
  role = "";
  children: Node[] = [];
  constructor(readonly tagName: string, readonly owner: Node | undefined, readonly nodeType = 1) {}
  getRootNode(): Node { return this.owner ?? this; }
  contains(node: Node): boolean { return this === node || this.children.some(child => child.contains(node)); }
  querySelectorAll(): Node[] { return this.children.flatMap(child => [child, ...child.querySelectorAll()]); }
  getAttribute(name: string): string | null { return name === "role" ? this.role : null; }
}

interface Record { type: string; target: Node; addedNodes?: Node[]; removedNodes?: Node[]; attributeName?: string; oldValue?: string }

function fixture() {
  const documents = [new Node("DOCUMENT", undefined), new Node("DOCUMENT", undefined)];
  const frame = new Node("IFRAME", documents[0]);
  const peers = [new Node("BUTTON", documents[0]), new Node("BUTTON", documents[1])];
  const clock = new Node("#text", documents[0], 3);
  const wrapper = new Node("SECTION", documents[1]);
  const label = new Node("#text", documents[1], 3);
  wrapper.children = [peers[1]!];
  peers[1]!.children = [label];
  documents[0]!.children = [peers[0]!, frame, clock];
  documents[1]!.children = [wrapper];
  const ids = new Map<string, Node>([["root", documents[0]!], ["frame", frame], ["child", documents[1]!], ["a", peers[0]!], ["b", peers[1]!]]);
  const queues: Record[][] = [[], []];
  const contexts = documents.map((document, index) => createContext({
    document,
    crypto: { getRandomValues: (values: Uint32Array) => values.fill(index + 1) },
    MutationObserver: class {
      observe() {}
      disconnect() {}
      takeRecords() { return queues[index]!.splice(0); }
    },
  }));
  const state = {
    raw: 'uid=root RootWebArea "Main"\n  uid=a button "Save"\n  uid=frame Iframe\n    uid=child RootWebArea "Child"\n      uid=b button "Save"',
    hook: undefined as ((name: string, args: { function?: unknown; args?: unknown }) => void) | undefined,
    reply: undefined as ((value: unknown) => unknown) | undefined,
  };
  const calls: Array<{ name: string; args: { function?: unknown; args?: unknown; verbose?: unknown } }> = [];
  const call = async (name: string, args: { function?: unknown; args?: unknown; verbose?: unknown } = {}): Promise<string> => {
    calls.push({ name, args });
    state.hook?.(name, args);
    if (name === "take_snapshot") return state.raw;
    if (name === "list_pages") return "0: https://example.test/ [selected]";
    if (name !== "evaluate_script") return "";
    const uids = (args.args ?? []) as string[];
    const nodes = uids.map(uid => {
      const node = ids.get(uid);
      if (!node) throw new Error(`Element uid "${uid}" not found on page 0.`);
      return node;
    });
    const document = nodes[0]?.getRootNode() ?? documents[0];
    if (nodes.some(node => node.getRootNode() !== document)) throw new Error("Elements from different frames cannot be evaluated together");
    const index = documents.indexOf(document!);
    const script = String(args.function);
    if (script.includes("const ids =") && script.includes("referenceReady")) {
      return JSON.stringify(Object.fromEntries(uids.map(uid => [uid, { referenceReady: true, occluded: false }])));
    }
    const result = runInContext(`(${script})`, contexts[index]!)(...nodes);
    return JSON.stringify(state.reply ? state.reply(result) : result);
  };
  const observation = new ChromeDocumentObservation(call, "test-guard", parseSnapshotRows);
  const selected = { uid: "a", role: "button", name: "Save" };
  const mutateClock = () => queues[0]!.push({ type: "characterData", target: clock });
  return { observation, selected, state, calls, ids, contexts, queues, documents, peers, frame, clock, wrapper, label, call, mutateClock };
}

test("unchanged framed documents validate exact refs with a global accessibility capture and closing sweep", async () => {
  const f = fixture();
  await f.observation.start(f.state.raw);
  f.calls.length = 0;
  await f.observation.validate(f.selected);
  expect(f.calls.filter(call => call.name === "take_snapshot")).toHaveLength(1);
  expect(f.calls.filter(call => call.name === "evaluate_script")).toHaveLength(4);
});

test("perception batches known documents without failed mixed-frame probes", async () => {
  const f = fixture();
  const driver = new ChromeDevToolsDriver({ promoteClickables: false });
  (driver as unknown as { call: typeof f.call }).call = f.call;
  const rows = await driver.snapshot({ perception: true });
  expect(rows.every(row => row.ref !== undefined)).toBe(true);
  expect(rows.map(row => [row.role, row.name])).toEqual([["RootWebArea", "Main"], ["button", "Save"], ["RootWebArea", "Child"], ["button", "Save"]]);
  const probes = f.calls.filter(call => String(call.args.function).includes("referenceReady"));
  expect(probes.map(probe => probe.args.args)).toEqual([["root", "a"], ["child", "b"]]);
  expect(await driver.locateRef(rows[3]!.ref!)).toEqual({ text: "Save", role: "button", index: 1, nth: 1 });
});

test.each(["root", "owner", "peer", "selected", "token", "detached", "shadow"])("document guards reject lost %s identity", async change => {
  const f = fixture();
  await f.observation.start(f.state.raw);
  if (change === "root") f.ids.set("root", new Node("DOCUMENT", f.documents[0]));
  if (change === "owner") f.ids.set("frame", new Node("IFRAME", f.documents[0]));
  if (change === "peer") f.ids.set("b", new Node("BUTTON", f.documents[1]));
  if (change === "selected") f.ids.set("a", new Node("BUTTON", f.documents[0]));
  if (change === "token") runInContext('globalThis[Symbol.for("test-guard")].token = "changed"', f.contexts[1]!);
  if (change === "detached") f.peers[1]!.isConnected = false;
  if (change === "shadow") f.peers[1]!.getRootNode = () => new Node("SHADOW", undefined);
  await expect(f.observation.validate(f.selected)).rejects.toThrow();
});

test("current root and peer UIDs may rotate while their saved DOM objects remain identical", async () => {
  const f = fixture();
  await f.observation.start(f.state.raw);
  for (const uid of ["root", "frame", "child", "b"]) {
    f.ids.set(`${uid}2`, f.ids.get(uid)!);
    f.ids.delete(uid);
    f.state.raw = f.state.raw.replace(`uid=${uid} `, `uid=${uid}2 `);
  }
  await expect(f.observation.validate(f.selected)).resolves.toBeUndefined();
});

test("a rotated selected AX UID still requires the original selected UID to resolve its saved node", async () => {
  const f = fixture();
  await f.observation.start(f.state.raw);
  f.ids.set("a2", f.ids.get("a")!);
  f.state.raw = f.state.raw.replace("uid=a ", "uid=a2 ");
  await expect(f.observation.validate(f.selected)).resolves.toBeUndefined();
  f.ids.set("a", new Node("BUTTON", f.documents[0]));
  await expect(f.observation.validate(f.selected)).rejects.toThrow(/continuity/);
});

test.each(["rename", "empty-frame-insertion"])("AX %s without DOM mutation still invalidates the global cohort", async change => {
  const f = fixture();
  const populated = f.state.raw;
  if (change === "empty-frame-insertion") f.state.raw = f.state.raw.replace('\n      uid=b button "Save"', "");
  await f.observation.start(f.state.raw);
  // CSSOM/media changes can reveal or rename an AX peer without a MutationObserver record.
  f.state.raw = change === "rename" ? f.state.raw.replace('uid=b button "Save"', 'uid=b button "Changed"') : populated;
  expect(f.queues.flat()).toHaveLength(0);
  await expect(f.observation.validate(f.selected)).rejects.toThrow(/global accessibility cohort/);
});

test.each(["role", "replacement", "ancestor", "descendant"])("retained %s mutations reject refs even if the fresh AX text is unchanged", async change => {
  const f = fixture();
  await f.observation.start(f.state.raw);
  if (change === "role") f.queues[1]!.push({ type: "attributes", target: new Node("SPAN", f.documents[1]), attributeName: "role", oldValue: "button" });
  if (change === "replacement") f.queues[1]!.push({ type: "childList", target: f.documents[1]!, addedNodes: [new Node("BUTTON", f.documents[1])], removedNodes: [] });
  if (change === "ancestor") f.queues[1]!.push({ type: "attributes", target: f.wrapper, attributeName: "class" });
  if (change === "descendant") f.queues[1]!.push({ type: "characterData", target: f.label });
  await expect(f.observation.validate(f.selected)).rejects.toThrow(/continuity/);
});

test("completed unrelated changes require a stable fresh capture and preserve the original objects", async () => {
  const f = fixture();
  await f.observation.start(f.state.raw);
  f.calls.length = 0;
  f.mutateClock();
  await expect(f.observation.validate(f.selected)).resolves.toBeUndefined();
  expect(f.calls.filter(call => call.name === "take_snapshot")).toHaveLength(2);
});

test.each([false, true])("closing sweep observes earlier-document changes during later validation (continuous=%s)", async continuous => {
  const f = fixture();
  await f.observation.start(f.state.raw);
  f.calls.length = 0;
  let changed = false;
  f.state.hook = (name, args) => {
    if (name === "evaluate_script" && (args.args as string[])[0] === "child" && String(args.function).includes("const elements") && (!changed || continuous)) {
      f.mutateClock();
      changed = true;
    }
  };
  if (continuous) await expect(f.observation.validate(f.selected)).rejects.toThrow(/stable document cohort/);
  else await expect(f.observation.validate(f.selected)).resolves.toBeUndefined();
  expect(f.calls.filter(call => call.name === "take_snapshot")).toHaveLength(2);
});

test("a frame without target-role peers still participates in the revision interval", async () => {
  const f = fixture();
  f.state.raw = f.state.raw.replace('\n      uid=b button "Save"', "");
  await f.observation.start(f.state.raw);
  f.calls.length = 0;
  f.queues[1]!.push({ type: "characterData", target: new Node("#text", f.documents[1], 3) });
  await expect(f.observation.validate(f.selected)).resolves.toBeUndefined();
  expect(f.calls.filter(call => call.name === "take_snapshot")).toHaveLength(2);
});

test("mutation overflow clears retained identities and rejects the observation", async () => {
  const f = fixture();
  await f.observation.start(f.state.raw);
  for (let i = 0; i < 4097; i++) f.mutateClock();
  await expect(f.observation.validate(f.selected)).rejects.toThrow(/continuity/);
  expect(runInContext('globalThis[Symbol.for("test-guard")].saved.size', f.contexts[0]!)).toBe(0);
});

test.each([undefined, -1, 0.5, "0", null])("malformed revision %s refuses guard validation", async revision => {
  const f = fixture();
  await f.observation.start(f.state.raw);
  f.state.reply = value => ({ ...(value as object), revision });
  await expect(f.observation.validate(f.selected)).rejects.toThrow(/continuity/);
});

test("unsupported topology and unmeasured document coverage cannot start an observation", async () => {
  const f = fixture();
  await expect(f.observation.start('uid=root RootWebArea "Main"\n  uid=frame Iframe')).rejects.toThrow(/topology/);
  const missing = fixture();
  missing.state.hook = name => { if (name === "take_snapshot") missing.state.raw += '\nuid=outside button "Outside"'; };
  await expect(missing.observation.start(missing.state.raw)).rejects.toThrow(/coverage/);
});

test("a guard transport failure is surfaced without another snapshot attempt", async () => {
  const f = fixture();
  await f.observation.start(f.state.raw);
  f.calls.length = 0;
  f.state.hook = name => { if (name === "evaluate_script") throw new Error("Connection closed"); };
  await expect(f.observation.validate(f.selected)).rejects.toThrow("Connection closed");
  expect(f.calls.filter(call => call.name === "take_snapshot")).toHaveLength(1);
});

test("a detached UID is isolated within its document batch without losing other facts", async () => {
  const f = fixture();
  const driver = new ChromeDevToolsDriver({ promoteClickables: false });
  (driver as unknown as { call: typeof f.call }).call = f.call;
  f.state.hook = (name, args) => {
    if (name === "evaluate_script" && String(args.function).includes("referenceReady")) f.ids.delete("b");
  };
  const rows = await driver.snapshot({ perception: true });
  expect(rows).toHaveLength(4);
  expect(rows.map(row => row.occluded)).toEqual([false, false, false, undefined]);
  expect(rows.every(row => row.ref === undefined)).toBe(true);
  expect(f.calls.filter(call => String(call.args.function).includes("referenceReady")).map(call => call.args.args))
    .toEqual([["root", "a"], ["child", "b"], ["child"], ["b"]]);
});

test("incomplete topology falls back to isolation without dropping an uncovered candidate", async () => {
  const f = fixture();
  const driver = new ChromeDevToolsDriver({ promoteClickables: false });
  (driver as unknown as { call: typeof f.call }).call = f.call;
  f.ids.set("outside", new Node("BUTTON", f.documents[0]));
  f.state.raw += '\nuid=outside button "Outside"';
  const rows = await driver.snapshot({ perception: true });
  expect(rows).toHaveLength(5);
  expect(rows.every(row => row.occluded === false && row.ref === undefined)).toBe(true);
  const firstProbe = f.calls.find(call => String(call.args.function).includes("referenceReady"));
  expect(firstProbe?.args.args).toEqual(["root", "a", "child", "b", "outside"]);
});
