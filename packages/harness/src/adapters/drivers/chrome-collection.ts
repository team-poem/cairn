/** Narrow, exact-node collection evidence. No accessible-name inference or visual ordering. */
import { CollectionSelectionError } from "../../core/collection.js";
import { extractFirstJsonObject } from "../../core/json.js";
import type { CollectionObservation, CollectionTarget, PageElement } from "../../core/types.js";
import { documentTopology } from "./chrome-documents.js";
import { DOM_FOREGROUND_PROBE } from "./dom-foreground.js";
import { HOST_ROOT_REGISTRY } from "./host-owned-roots.js";

interface Row { uid: string; role: string; name: string; collectionUid?: string; itemUid?: string }
interface Plan { rows: Row[]; root: number; items: number[]; actions: number[]; conditions: number[] }
interface Measurement {
  complete?: unknown;
  reason?: unknown;
  items?: Array<{ action?: number; disabled?: boolean; occluded?: boolean }>;
  conditions?: CollectionObservation["conditions"];
}
type Call = (name: string, args?: Record<string, unknown>) => Promise<string>;

/** Unnamed structural AX rows intentionally stay outside legacy locator ordinal pools. */
export function collectionRows(raw: string): Row[] {
  return raw.split("\n").flatMap(line => {
    const match = line.match(/^\s*uid=(\S+)\s+(\w+)(.*)$/);
    if (!match) return [];
    let tail = match[3]!.trim(), name = "";
    if (tail.startsWith('"')) {
      const end = tail.indexOf('"', 1);
      if (end < 0) throw new CollectionSelectionError("unsupported", "MCP collection names require single-line unambiguous quoting");
      name = tail.slice(1, end);
      tail = tail.slice(end + 1);
    }
    // MCP 1.8 interpolates names rather than JSON-escaping them. Never interpret a partial
    // quoted name as an exact locator; visibly ambiguous embedded quotes are unsupported.
    tail = tail.trim();
    if (tail && !/^[a-zA-Z][\w-]*(?:="[^"]*")?(?:\s+[a-zA-Z][\w-]*(?:="[^"]*")?)*$/.test(tail)) {
      throw new CollectionSelectionError("unsupported", "MCP collection names or attributes have ambiguous quoting");
    }
    return [{ uid: match[1]!, role: match[2]!, name }];
  });
}

/** One captured declaration; saved DOM objects live in the existing bounded observation guard. */
export class ChromeCollectionObservation {
  private readonly key: string;
  private captured = false;

  constructor(
    private readonly selection: CollectionTarget,
    private readonly call: Call,
    private readonly capture: () => Promise<string>,
    private readonly guardKey: string,
    identity: string,
    private readonly hostKey?: string,
    private readonly hostStamp?: string,
  ) { this.key = `collection:${identity}`; }

  async start(raw: string, candidates: ReadonlyMap<string, PageElement>): Promise<CollectionObservation> {
    const plan = this.plan(raw);
    // The initial AX snapshot follows installation of a fresh guard. Any mutation before
    // measurement leaves that first semantic capture unproven, including external labels.
    const result = await this.measure(plan, 0);
    if (!Array.isArray(result.items) || !Array.isArray(result.conditions) || result.conditions.length !== plan.conditions.length) {
      throw new CollectionSelectionError("incomplete", "collection measurement is unavailable");
    }
    const complete = result.complete === true;
    this.captured = complete;
    return {
      order: "dom", complete,
      items: result.items.map((item, position) => {
        const row = typeof item.action === "number" && Number.isInteger(item.action) ? plan.rows[item.action] : undefined;
        const target = row && plan.actions.includes(item.action!) ? candidates.get(row.uid) : undefined;
        return { position, ...(typeof item.disabled === "boolean" ? { disabled: item.disabled } : {}),
          ...(complete && target?.ref ? { target: { ...target, disabled: item.disabled === true || target.disabled === true,
            ...(typeof item.occluded === "boolean" ? { occluded: item.occluded } : {}) } } : {}) };
      }),
      conditions: result.conditions,
    };
  }

  async validate(uid: string): Promise<void> {
    if (!this.captured) throw new CollectionSelectionError("stale", "collection observation is unavailable");
    const before = extractFirstJsonObject(await this.call("evaluate_script", {
      function: `() => {
        const state = globalThis[Symbol.for(${JSON.stringify(this.guardKey)})];
        if (!state?.observer || state.overflow) return {};
        state.retain(state.observer.takeRecords());
        return state.overflow ? {} : {revision:state.records.length};
      }`,
    })) as { revision?: unknown } | undefined;
    if (!Number.isSafeInteger(before?.revision)) throw new CollectionSelectionError("stale", "collection guard revision is unavailable");
    const result = await this.measure(this.plan(await this.capture()), before!.revision as number, uid);
    if (result.complete !== true) throw new CollectionSelectionError("stale", "collection membership, state or exact nodes changed");
  }

  private plan(raw: string): Plan {
    if (documentTopology(raw).framed) throw new CollectionSelectionError("unsupported", "collection selection requires a top-level document");
    const all = collectionRows(raw);
    // Keep browser AX ancestry instead of reconstructing accessibility membership from
    // DOM parents. aria-owns can move an otherwise unchanged DOM node to another owner.
    const stack: Array<{ row: Row; indent: number }> = [];
    let offset = 0;
    for (const line of raw.split("\n")) {
      const match = line.match(/^(\s*)uid=\S+\s+\w+/);
      if (!match) continue;
      const row = all[offset++]!;
      const indent = match[1]!.length;
      while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
      let boundary = stack.length - 1;
      while (boundary >= 0 && !["list", "listbox"].includes(stack[boundary]!.row.role)) boundary--;
      row.collectionUid = stack[boundary]?.row.uid;
      let item = stack.length - 1;
      while (item > boundary && stack[item]!.row.role !== this.selection.itemRole) item--;
      row.itemUid = row.role === this.selection.itemRole ? row.uid
        : item > boundary ? stack[item]!.row.uid : undefined;
      stack.push({ row, indent });
    }
    const matches = (role: string, name?: string) => all.filter(row => row.role === role && (name === undefined || row.name === name));
    const roots = matches(this.selection.root.role, this.selection.root.name);
    if (roots.length !== 1) throw new CollectionSelectionError(roots.length ? "ambiguous" : "missing", "named collection root is not unique and present");
    const conditions = (this.selection.conditions ?? []).map(condition => {
      const found = matches(condition.control.role, condition.control.name);
      if (found.length !== 1) throw new CollectionSelectionError("condition", "declared control is not uniquely present");
      return found[0]!;
    });
    const items = matches(this.selection.itemRole).filter(row => row.collectionUid === roots[0]!.uid);
    const actions = matches(this.selection.target.role, this.selection.target.name);
    const rows = [...new Map([roots[0]!, ...items, ...actions, ...conditions].map(row => [row.uid, row])).values()];
    if (rows.length > 4096) throw new CollectionSelectionError("incomplete", "collection measurement exceeds its node bound");
    const index = (row: Row) => rows.findIndex(candidate => candidate.uid === row.uid);
    return { rows, root: index(roots[0]!), items: items.map(index), actions: actions.map(index), conditions: conditions.map(index) };
  }

  private async measure(plan: Plan, revision: number, selected?: string): Promise<Measurement> {
    const result = extractFirstJsonObject(await this.call("evaluate_script", {
      function: this.script(plan, revision, selected),
      args: [...plan.rows.map(row => row.uid), ...(selected === undefined ? [] : [selected])],
    }));
    if (!result || typeof result !== "object") throw new CollectionSelectionError("incomplete", "collection DOM measurement failed");
    return result as Measurement;
  }

  private script(plan: Plan, revision: number, selected?: string): string {
    return `(...args) => {
      const spec = ${JSON.stringify(this.selection)}, plan = ${JSON.stringify(plan)};
      const selected = ${JSON.stringify(selected ?? null)}, nodes = args.slice(0, plan.rows.length);
      const state = globalThis[Symbol.for(${JSON.stringify(this.guardKey)})];
      const fail = reason => ({complete:false, reason, items:[], conditions:[]});
      if (window.top !== window || !state?.observer || state.overflow) return fail('guard');
      state.retain(state.observer.takeRecords());
      if (state.records.length !== ${revision}) return fail('accessibility capture changed');
      if (state.overflow) return fail('coverage');
      const registry = ${this.hostKey ? `(${HOST_ROOT_REGISTRY})(${JSON.stringify(this.hostKey)})` : "null"};
      const ownership = registry?.status();
      if (ownership?.unsupported || (${JSON.stringify(this.hostStamp ?? null)} !== null && ownership?.stamp !== ${JSON.stringify(this.hostStamp ?? null)})) return fail('ownership');
      const element = node => node?.nodeType === 3 ? node.parentElement : node;
      const local = node => !!node?.isConnected && node.getRootNode() === document;
      if (![plan.root, ...plan.conditions].every(index => local(nodes[index]))) return fail('coverage');
      const root = element(nodes[plan.root]);
      const protectedScopes = [root, ...plan.conditions.map(index => element(nodes[index]))];
      const overlaps = node => !!node && protectedScopes.some(scope =>
        scope === node || scope.contains(node) || node.contains?.(scope));
      // Incoming relations may originate anywhere, including host-owned UI or an open
      // shadow tree. Property-only element references have neither an ID nor a DOM
      // mutation record, so querySelectorAll('[aria-owns]') is not sufficient.
      const trees = [document];
      let ownershipWork = 0;
      const attributeTargets = (owner, value) => {
        if (value.length > 65536) return null;
        const tree = owner.getRootNode();
        const tokens = value.trim() ? value.trim().split(/\\s+/) : [];
        ownershipWork += tokens.length;
        return tokens.map(id => tree.getElementById?.(id)).filter(Boolean);
      };
      while (trees.length) {
        const walk = document.createTreeWalker(trees.pop(), NodeFilter.SHOW_ELEMENT);
        for (let owner = walk.nextNode(); owner; owner = walk.nextNode()) {
          if (++ownershipWork > 16384) return fail('ownership coverage bound');
          if (owner.shadowRoot) trees.push(owner.shadowRoot);
          const attr = attributeTargets(owner, owner.getAttribute('aria-owns') || '');
          const refs = owner.ariaOwnsElements;
          if (!attr || (refs != null && !Array.isArray(refs))) return fail('ownership coverage');
          ownershipWork += refs?.length || 0;
          if (ownershipWork > 16384 || attr.some(overlaps) || refs?.some(overlaps)) return fail('incoming ownership');
          if (protectedScopes.includes(owner) && (attr.length || refs?.length)) return fail('outgoing ownership');
        }
      }
      // Even a reverted attribute relation invalidates a binding when the old targets
      // are still identifiable. Current property references are checked above each time.
      for (const record of state.records) {
        if (record.type !== 'attributes' || record.attributeName !== 'aria-owns') continue;
        const previous = attributeTargets(record.target, record.oldValue || '');
        if (!previous || ownershipWork > 16384 || previous.some(overlaps)) return fail('ownership changed');
      }
      // Unsupported peers outside this collection do not define its coverage. But a
      // matching AX node inside even a closed shadow tree in this scope must not disappear
      // from the action/member pool merely because a light-DOM walk cannot reach it.
      const insideScope = node => {
        for (let current = node; current; current = current.getRootNode?.().host) {
          if (current === root || root.contains(current)) return true;
        }
        return false;
      };
      if (nodes.some(node => !local(node) && insideScope(node))) return fail('unsupported scoped node');
      const role = el => (el.getAttribute('role') || '').trim().split(/\\s+/)[0];
      const collectionRole = el => role(el) || (/^(UL|OL)$/.test(el.tagName) ? 'list'
        : el.tagName === 'SELECT' && (el.multiple || el.size > 1) ? 'listbox' : '');
      const itemRole = el => role(el) || (el.tagName === 'LI' ? 'listitem' : el.tagName === 'OPTION' ? 'option' : '');
      const owner = el => {
        for (let p = el.parentElement; p; p = p.parentElement) if (['list','listbox'].includes(collectionRole(p))) return p;
      };
      const disabled = el => {
        for (let p = el; p; p = p.parentElement) if (p.matches(':disabled') || p.getAttribute('aria-disabled') === 'true') return true;
        return false;
      };
      const rendered = el => {
        if (!el || el.nodeType !== 1 || !el.isConnected || el.getRootNode() !== document || !el.getClientRects().length) return false;
        if (['hidden','collapse'].includes(getComputedStyle(el).visibility)) return false;
        for (let p = el; p; p = p.parentElement) {
          const style = getComputedStyle(p);
          if (p.hidden || p.getAttribute('aria-hidden') === 'true' || p.getAttribute('aria-busy') === 'true' ||
              style.display === 'none' || style.opacity === '0' || style.contentVisibility === 'hidden') return false;
        }
        return true;
      };
      if (!rendered(root) || collectionRole(root) !== spec.root.role || registry?.excluded(root)) return fail('root');
      // A DOM walk establishes all local members, independently of named/model-budgeted AX rows.
      const members = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let count = 0, el = root;
      do {
        if (++count > 4096 || el.shadowRoot || /^(IFRAME|FRAME)$/.test(el.tagName) ||
            el.hasAttribute('aria-owns') || el.ariaOwnsElements?.length) return fail('unsupported topology');
        if (itemRole(el) === spec.itemRole && owner(el) === root) members.push(el);
        el = walker.nextNode();
      } while (el);
      if (members.some(member => !rendered(member) || registry?.excluded(member))) return fail('hidden member');
      const axMembers = plan.items.filter(index => local(nodes[index])).map(index => element(nodes[index]));
      if (new Set(axMembers).size !== axMembers.length || axMembers.length !== members.length ||
          members.some((member, index) => member !== axMembers[index])) return fail('partial accessibility membership');
      for (const index of plan.actions) {
        const action = element(nodes[index]);
        const member = local(action) && owner(action) === root
          ? members.findIndex(member => member === action || member.contains(action)) : -1;
        const axInside = plan.rows[index].collectionUid === plan.rows[plan.root].uid &&
          plan.rows[index].itemUid !== undefined;
        if ((member >= 0) !== axInside || (member >= 0 &&
            plan.rows[index].itemUid !== plan.rows[plan.items[member]].uid)) return fail('accessibility action membership');
      }
      const positiveInteger = value => /^\\d+$/.test(value || '') && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
      const anyPosition = members.some(member => member.hasAttribute('aria-setsize') || member.hasAttribute('aria-posinset'));
      const totalKnown = members.length > 0 && members.every((member, index) =>
        positiveInteger(member.getAttribute('aria-setsize')) === members.length && positiveInteger(member.getAttribute('aria-posinset')) === index + 1);
      // Declared total is not permission to disregard contradictory partial/virtualized metadata.
      let complete = (!anyPosition || totalKnown) && (totalKnown || spec.expectedCount === members.length);
      if (root.hasAttribute('aria-rowcount') && positiveInteger(root.getAttribute('aria-rowcount')) !== members.length) complete = false;
      if (spec.expectedCount !== undefined && spec.expectedCount !== members.length) complete = false;
      const choices = members.map((member, position) => {
        const matches = plan.actions.filter(index => {
          if (!local(nodes[index])) return false;
          const action = element(nodes[index]);
          return (action === member || member.contains(action)) && owner(action) === root &&
            plan.rows[index].itemUid === plan.rows[plan.items[position]].uid &&
            !registry?.excluded(nodes[index], plan.rows[index].role === 'StaticText');
        });
        // Missing, ambiguous and disabled actions do not remove their item from the ordinal pool.
        const action = matches.length === 1 ? matches[0] : undefined;
        if (action !== undefined && !rendered(element(nodes[action]))) complete = false;
        return { ...(action !== undefined ? {action} : {}), disabled: disabled(member) || (action !== undefined && disabled(element(nodes[action]))) };
      });
      const conditionNodes = plan.conditions.map(index => nodes[index]);
      if (conditionNodes.some(node => !rendered(element(node)) || registry?.excluded(node))) return fail('conditions');
      const conditions = conditionNodes.map(node => {
        const el = element(node), out = {disabled:disabled(el)};
        if (typeof el.value === 'string') out.value = el.value;
        else if (el.hasAttribute('aria-valuetext')) out.value = el.getAttribute('aria-valuetext');
        else if (el.hasAttribute('aria-sort')) out.value = el.getAttribute('aria-sort');
        if (el.matches('input[type=checkbox],input[type=radio]')) out.checked = el.indeterminate ? 'mixed' : el.checked;
        else if (el.getAttribute('aria-checked') === 'mixed') out.checked = 'mixed';
        else if (['true','false'].includes(el.getAttribute('aria-checked'))) out.checked = el.getAttribute('aria-checked') === 'true';
        return out;
      });
      const protectedNodes = [root, ...conditionNodes.map(element)];
      const contains = (parent, child) => parent === child || parent.contains?.(child);
      const touches = node => protectedNodes.some(protectedNode => contains(protectedNode, node) || contains(node, protectedNode));
      if (state.records.some(record => touches(record.target) ||
          (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(touches)))) return fail('mutated collection');
      const actionNodes = choices.map(choice => choice.action === undefined ? null : nodes[choice.action]);
      const actionFacts = (${DOM_FOREGROUND_PROBE})(...actionNodes.map(element));
      choices.forEach((choice, index) => {
        if (typeof actionFacts[index]?.occluded === 'boolean') choice.occluded = actionFacts[index].occluded;
      });
      const semantics = choices.map(choice => choice.action === undefined ? null : [plan.rows[choice.action].role, plan.rows[choice.action].name]);
      const signature = JSON.stringify([choices.map(choice => [choice.disabled, choice.occluded]), semantics, conditions, complete]);
      state.retain(state.observer.takeRecords());
      if (state.overflow || state.records.length !== ${revision} ||
          (registry && registry.status().stamp !== ownership.stamp)) return fail('measurement changed');
      state.collections ??= new Map();
      const key = ${JSON.stringify(this.key)}, saved = state.collections.get(key);
      if (selected !== null) {
        if (!saved || !complete || saved.root !== root || saved.members.length !== members.length ||
            members.some((node, index) => node !== saved.members[index]) ||
            actionNodes.some((node, index) => node !== saved.actions[index]) ||
            conditionNodes.some((node, index) => node !== saved.conditions[index]) || signature !== saved.signature ||
            args[args.length - 1] !== saved.nodes.get(selected) || !actionNodes.includes(args[args.length - 1])) return fail('changed collection');
        const selectedItem = actionNodes.indexOf(args[args.length - 1]);
        if (choices[selectedItem]?.disabled || choices[selectedItem]?.occluded) return fail('ineligible action');
      } else if (complete) {
        state.collections.set(key, {root, members, actions:actionNodes, conditions:conditionNodes, signature,
          nodes:new Map(plan.rows.map((row, index) => [row.uid, nodes[index]]))});
      }
      return {complete, items:choices, conditions};
    }`;
  }
}
