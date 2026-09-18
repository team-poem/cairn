/** Document-local Chrome observation state. Durable locators retain the global AX row pool. */
import { extractFirstJsonObject } from "../../core/json.js";

interface Row { uid: string; role: string; name: string }
interface DocumentRoot { uid: string; parent?: number; owner?: string }
export interface DocumentTopology {
  framed: boolean;
  valid: boolean;
  documents: DocumentRoot[];
  membership: Map<string, number>;
}

/** Read structural ancestry without adding unnamed AX scaffolding to durable locator ordinals. */
export function documentTopology(raw: string): DocumentTopology {
  const documents: DocumentRoot[] = [];
  const membership = new Map<string, number>();
  const stack: Array<{ indent: number; uid: string; role: string; document?: number }> = [];
  const owners = new Set<string>();
  const attached = new Set<string>();
  let valid = true;
  let framed = false;
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\s*)uid=(\S+)\s+(\w+)(?:\s|$)/);
    if (!match) continue;
    const [, space, uid, role] = match as unknown as [string, string, string, string];
    const indent = space.length;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    let document = parent?.document;
    if (role === "Iframe") { framed = true; owners.add(uid); }
    if (role === "RootWebArea") {
      if (documents.length) framed = true;
      const owner = parent?.role === "Iframe" ? parent : undefined;
      if (documents.length && (!owner || owner.document === undefined)) valid = false;
      if (!documents.length && parent) valid = false;
      document = documents.length;
      documents.push({ uid, ...(owner ? { owner: owner.uid, parent: owner.document } : {}) });
      if (owner) { if (attached.has(owner.uid)) valid = false; attached.add(owner.uid); }
    }
    // Virtual glyph runs may alias another UID, even across frames. They do not own
    // nodes or participate in semantic row pools and must never overwrite membership.
    if (role !== "InlineTextBox") {
      if (membership.has(uid)) valid = false;
      if (document !== undefined) membership.set(uid, document);
    }
    stack.push({ indent, uid, role, document });
  }
  if ([...owners].some(uid => !attached.has(uid))) valid = false;
  if (framed && (!documents.length || membership.size === 0)) valid = false;
  return { framed, valid, documents, membership };
}

type Call = (name: string, args?: Record<string, unknown>) => Promise<string>;
interface GuardReply { token?: unknown; revision?: unknown; connected?: unknown }
interface Capture { raw: string; rows: Row[]; topology: DocumentTopology }

/** All captured documents protect one global positional cohort, including empty child documents. */
export class ChromeDocumentObservation {
  private readonly tokens: string[] = [];
  private revisions: number[] = [];
  private capture!: Capture;

  constructor(private readonly call: Call, private readonly key: string, private readonly parse: (raw: string) => Row[]) {}

  async start(raw: string): Promise<string> {
    const bootstrap = documentTopology(raw);
    if (!bootstrap.framed || !bootstrap.valid) throw new Error("unsupported document topology");
    for (const root of bootstrap.documents) {
      const result = await this.evaluate(`(root) => {
        if (root !== document) return { connected: false };
        const key = Symbol.for(${JSON.stringify(this.key)});
        globalThis[key]?.observer?.disconnect();
        const state = { token: Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-'), document, records: [], saved: new Map(), overflow: false, observer: undefined, retain: undefined };
        state.retain = records => {
          if (state.overflow) return;
          if (state.records.length + records.length > 4096) {
            state.overflow = true; state.records.length = 0; state.saved.clear(); state.observer.disconnect(); return;
          }
          state.records.push(...records);
        };
        state.observer = new MutationObserver(records => state.retain(records));
        state.observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true });
        globalThis[key] = state;
        return { connected: true, token: state.token };
      }`, [root.uid]);
      if (result.connected !== true || typeof result.token !== "string") throw new Error("document guard unavailable");
      this.tokens.push(result.token);
    }
    raw = await this.call("take_snapshot", { verbose: true });
    const topology = documentTopology(raw);
    if (!this.sameTopology(bootstrap, topology)) throw new Error("document topology changed during capture");
    this.capture = { raw, topology, rows: this.parse(raw).filter(row => row.role !== "InlineTextBox") };
    for (const row of this.capture.rows) if (!topology.membership.has(row.uid)) throw new Error("unknown document coverage");
    for (const [index, root] of topology.documents.entries()) {
      const ids = this.documentIds(this.capture, index);
      const result = await this.evaluate(`(root, ...nodes) => {
        const state = globalThis[Symbol.for(${JSON.stringify(this.key)})];
        if (!state?.observer || state.overflow || root !== document || state.document !== document ||
            state.token !== ${JSON.stringify(this.tokens[index])}) return { connected: false };
        state.retain(state.observer.takeRecords());
        const ids = ${JSON.stringify(ids)};
        if (state.overflow || nodes.length !== ids.length || nodes.some(node => !node?.isConnected || node.getRootNode() !== document)) return { connected: false };
        state.saved = new Map(ids.map((uid, index) => [uid, nodes[index]]));
        return { connected: true, token: state.token, revision: state.records.length };
      }`, [root.uid, ...ids]);
      this.requireGuard(result, index);
      this.revisions.push(result.revision as number);
    }
    return raw;
  }

  async validate(selected: Row): Promise<void> {
    const original = this.capture;
    const role = selected.role;
    const projection = (capture: Capture) => capture.rows.filter(row => row.role === role)
      .map(row => [capture.topology.membership.get(row.uid), row.role, row.name]);
    let revisions = this.revisions;
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.call("take_snapshot", { verbose: true });
      const current = { raw, topology: documentTopology(raw), rows: this.parse(raw).filter(row => row.role !== "InlineTextBox") };
      if (!this.sameTopology(original.topology, current.topology) ||
          JSON.stringify(projection(original)) !== JSON.stringify(projection(current))) {
        throw new Error("document or global accessibility cohort changed");
      }
      const after: number[] = [];
      for (const [index, root] of current.topology.documents.entries()) {
        const originalPeers = original.rows.filter(row => row.role === role && original.topology.membership.get(row.uid) === index);
        const peers = current.rows.filter(row => row.role === role && current.topology.membership.get(row.uid) === index);
        const originalOwners = original.topology.documents.filter(doc => doc.parent === index).map(doc => doc.owner!);
        const owners = current.topology.documents.filter(doc => doc.parent === index).map(doc => doc.owner!);
        const ids = [root.uid, ...owners, ...peers.map(row => row.uid)];
        const keys = [original.topology.documents[index]!.uid, ...originalOwners, ...originalPeers.map(row => row.uid)];
        if (original.topology.membership.get(selected.uid) === index) { ids.push(selected.uid); keys.push(selected.uid); }
        const result = await this.evaluate(this.validationScript(keys, originalPeers.map(row => row.uid), role, index), [root.uid, ...ids]);
        this.requireGuard(result, index);
        after.push(result.revision as number);
      }
      // A later frame evaluation can overlap a mutation in an earlier document. Close the
      // substantive validation interval with a lightweight revision sweep over every root.
      const closing: number[] = [];
      for (const [index, root] of current.topology.documents.entries()) {
        const result = await this.evaluate(`root => {
          const state = globalThis[Symbol.for(${JSON.stringify(this.key)})];
          if (!state?.observer || state.overflow || root !== document || state.document !== document) return { connected: false };
          state.retain(state.observer.takeRecords());
          return { connected: !state.overflow, token: state.token, revision: state.records.length };
        }`, [root.uid]);
        this.requireGuard(result, index);
        closing.push(result.revision as number);
      }
      if (closing.every((value, index) => value === after[index] && value === revisions[index])) {
        this.revisions = closing;
        return;
      }
      revisions = closing;
    }
    throw new Error("observation could not validate a stable document cohort");
  }

  private validationScript(keys: string[], peerIds: string[], role: string, index: number): string {
    return `(root, ...nodes) => {
      const state = globalThis[Symbol.for(${JSON.stringify(this.key)})];
      if (!state?.observer || state.overflow || state.token !== ${JSON.stringify(this.tokens[index])} || root !== document || state.document !== document) return { connected: false };
      state.retain(state.observer.takeRecords());
      const keys = ${JSON.stringify(keys)};
      if (state.overflow || keys.length !== nodes.length || nodes.some((node, index) =>
          !node?.isConnected || node.getRootNode() !== document || node !== state.saved.get(keys[index]))) return { connected: false };
      const elements = ${JSON.stringify(peerIds)}.map(uid => state.saved.get(uid)).map(node => node.nodeType === 3 ? node.parentElement : node);
      const contains = (parent, child) => parent === child || parent.contains?.(child);
      const inside = node => elements.some(element => contains(element, node));
      const ancestor = node => elements.some(element => contains(node, element));
      const tags = new Set(elements.filter(node => node.nodeType === 1).map(node => node.tagName));
      const role = ${JSON.stringify(role)};
      const couldJoin = node => node.nodeType === 1 && [node, ...node.querySelectorAll('*')].some(element =>
        tags.has(element.tagName) || (element.getAttribute('role') || '').split(/\\s+/).includes(role));
      const affects = record => {
        if (record.type === 'childList') return inside(record.target) ||
          [...record.removedNodes, ...record.addedNodes].some(node => ancestor(node) || couldJoin(node));
        if (inside(record.target) || (record.type === 'attributes' && ancestor(record.target))) return true;
        return record.type === 'attributes' && record.attributeName === 'role' &&
          [record.oldValue || '', record.target.getAttribute('role') || ''].some(value => value.split(/\\s+/).includes(role));
      };
      return { connected: !state.records.some(affects), token: state.token, revision: state.records.length };
    }`;
  }

  private documentIds(capture: Capture, index: number): string[] {
    return [...new Set([capture.topology.documents[index]!.uid,
      ...capture.topology.documents.filter(doc => doc.parent === index).map(doc => doc.owner!),
      ...capture.rows.filter(row => capture.topology.membership.get(row.uid) === index).map(row => row.uid)])];
  }

  private sameTopology(expected: DocumentTopology, actual: DocumentTopology): boolean {
    return actual.valid && expected.documents.length === actual.documents.length &&
      expected.documents.every((document, index) => document.parent === actual.documents[index]!.parent);
  }

  private requireGuard(result: GuardReply, index: number): void {
    if (result.connected !== true || result.token !== this.tokens[index] ||
        typeof result.revision !== "number" || !Number.isInteger(result.revision) || result.revision < 0) {
      throw new Error("document guard or original node continuity unavailable");
    }
  }

  private async evaluate(script: string, ids: string[]): Promise<GuardReply> {
    return extractFirstJsonObject(await this.call("evaluate_script", { function: script, args: ids })) as GuardReply ?? {};
  }
}
