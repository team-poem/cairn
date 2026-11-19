import type { PageGuidanceLocator, PageGuidanceScope, PageGuidanceScopeFacts } from "../../core/guidance-scope.js";
import type { PageElement } from "../../core/types.js";
import { extractFirstJsonObject } from "../../core/json.js";
import { collectionRows } from "./chrome-collection.js";
import { documentTopology } from "./chrome-documents.js";
import { DOM_FOREGROUND_PROBE } from "./dom-foreground.js";
import { HOST_ROOT_REGISTRY } from "./host-owned-roots.js";

/** Use the complete sanitized AX tree for names and ancestry, not the model's reduced listing.
 * UIDs last only until MCP's next snapshot; pass the original nodes to a single DOM measurement. */
export function prepareChromeGuidanceScope(
  raw: string, listing: ReadonlyMap<string, PageElement> | undefined, scope: PageGuidanceScope, guardKey: string, version: number,
  evaluate: (source: string, uids: string[]) => Promise<string>,
  host?: { key: string; stamp: string },
): { uid?: string; measure(): Promise<PageGuidanceScopeFacts | undefined> } | undefined {
  const topology = documentTopology(raw);
  if (topology.framed || !topology.valid || topology.documents.length !== 1 || scope.target.role !== "button") return;
  const locators = [scope.target, ...scope.prerequisites.map(p => "container" in p ? p.container : p)];
  const roles = new Set([...locators.map(loc => loc.role), ...scope.prerequisites.flatMap(p =>
    "container" in p ? [p.memberRole] : [])]);
  // Every structural row contributes ancestry. Only scoped roles need an exact name and
  // state. MCP's unescaped quotes in a StaticText (or another unrelated role) cannot
  // change which controls match. A quoted peer with a different prefix is not a match
  // either. Never use that shortcut for a set member, whose full name is a measured fact.
  const rows = raw.split("\n").flatMap(line => {
    const m = line.match(/^(\s*)uid=(\S+)\s+(\w+)/);
    if (!m) return [];
    let name = "", ambiguous = false;
    if (roles.has(m[3]!)) {
      try { name = collectionRows(line)[0]!.name; }
      catch (err) {
        const prefix = line.slice(m[0].length).match(/^\s+"([^"]*)/)?.[1];
        if (!prefix || locators.some(loc => loc.role === m[3] &&
            loc.name.trim().toLowerCase().startsWith(prefix.trim().toLowerCase()))) throw err;
        ambiguous = true;
      }
    }
    return [{ uid: m[2]!, role: m[3]!, name, indent:m[1]!.length, ambiguous }];
  });
  const ax = new Map<string, { checked: boolean | "mixed"; value?: string; disabled: boolean }>();
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\s*)uid=(\S+)\s+\w+(?:\s+"[^"]*")?(.*)$/);
    if (!match) continue;
    const tail = match[3]!;
    ax.set(match[2]!, { checked: /(?:^|\s)checked="mixed"(?:\s|$)/.test(tail) ? "mixed" : /(?:^|\s)checked(?:\s|$)/.test(tail),
      value: tail.match(/(?:^|\s)value="([^"]*)"/)?.[1], disabled: /(?:^|\s)disabled(?:\s|$)/.test(tail) });
  }
  const matches = (locator: PageGuidanceLocator) => rows.filter(r => r.role === locator.role && r.name === locator.name);
  const targetRows = matches(scope.target);
  // Chrome's durable name resolver folds case. A case-only collision cannot authorize a unique click.
  if (rows.some(r => r.role === scope.target.role && r.name !== scope.target.name &&
      r.name.toLowerCase() === scope.target.name.trim().toLowerCase())) return;
  const selected = new Map<string, number>();
  const nodes: typeof rows = [];
  const index = (row: typeof rows[number]) => {
    if (!selected.has(row.uid)) { selected.set(row.uid, nodes.length); nodes.push(row); }
    return selected.get(row.uid)!;
  };
  const targets = targetRows.map(index);
  const groups: Array<{ root?: number; members: number[] }> = [];
  for (const p of scope.prerequisites) {
    if (!("container" in p)) {
      if (!["checkbox", "radio", "combobox"].includes(p.role)) return;
      groups.push({ members: matches(p).map(index) });
      continue;
    }
    if (p.memberRole !== "checkbox" || !["list", "group"].includes(p.container.role)) return;
    const roots = matches(p.container);
    if (roots.length !== 1) return;
    const root = roots[0]!, start = rows.indexOf(root), members: number[] = [];
    for (let i = start + 1; i < rows.length && rows[i]!.indent > root.indent; i++) {
      if (rows[i]!.role === p.memberRole) {
        if (rows[i]!.ambiguous) return;
        members.push(index(rows[i]!));
      }
    }
    groups.push({ root: index(root), members });
  }
  if (nodes.length > 256 + scope.prerequisites.length) return;
  // A nonmatching AX peer can still be renamed before dispatch. Check that every
  // observed peer in these roles is addressable by the light-DOM inventory as well.
  // In particular, el.shadowRoot cannot reveal an ancestor's closed shadow tree.
  const peers = rows.filter(r => roles.has(r.role) && !selected.has(r.uid));
  if (nodes.length + peers.length > 4096) return;
  const states = nodes.map(r => ({...ax.get(r.uid), occluded:listing?.get(r.uid)?.occluded,
    inActivePopup:listing?.get(r.uid)?.inActivePopup === true}));
  const source = String.raw`(...els) => {
    const rows = ${JSON.stringify(nodes)}, groups = ${JSON.stringify(groups)}, targets = ${JSON.stringify(targets)};
    const states = ${JSON.stringify(states)};
    const scope = ${JSON.stringify(scope)};
    const guardKey = ${JSON.stringify(guardKey)}, guard = globalThis[Symbol.for(guardKey)];
    if (window.top !== window || !guard?.observer || guard.version !== ${version} || guard.url !== location.href) return {};
    if (els.some(el =>
      !(el instanceof Element) || !el.isConnected || el.getRootNode() !== document)) return {};
    const registry = ${host ? `(${HOST_ROOT_REGISTRY})(${JSON.stringify(host.key)})` : "null"};
    const ownership = registry?.status();
    if (registry && (ownership.unsupported || ownership.stamp !== ${JSON.stringify(host?.stamp ?? null)})) return {};
    const excluded = el => ownership?.active > 0 && registry.excluded(el);

    // Do not replay the AX snapshot's array of handles as if it were a live query.
    // Prove that the current light DOM yields the same matches, in order, including
    // candidates absent from that snapshot. Keep the supported naming and role rules
    // deliberately small. Unknown is not the empty name or a reason to drop a peer.
    const relevant = new Set(${JSON.stringify([...roles])}), all = [], decorative = new Set();
    const walk = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
    for (let el; (el = walk.nextNode());) {
      if (all.length + decorative.size >= 4096 || el.shadowRoot || el.localName.includes('-') || el.hasAttribute('is') ||
          el.matches('iframe,frame,object,embed,audio[controls],video[controls],[aria-owns]') || el.ariaOwnsElements?.length) return {};
      if (el.namespaceURI === 'http://www.w3.org/1999/xhtml') all.push(el);
      else if (el.namespaceURI === 'http://www.w3.org/2000/svg' && el.closest('svg[aria-hidden="true" i]') &&
          el.matches('svg,g,path,circle,ellipse,line,polyline,polygon,rect,title,desc') &&
          !el.matches('[tabindex],[focusable="true" i],:focus,[contenteditable],[role]:not([role="img"])')) decorative.add(el);
      else return {};
    }
    const fail = () => { throw Error('Unmeasurable guidance scope'); };
    const supported = el => {
      const tag = el.localName, explicit = el.getAttribute('role');
      if (explicit) {
        const tokens = explicit.trim().toLowerCase().split(/\s+/);
        if (tokens.some(r => relevant.has(r))) {
          if (tokens.length === 1) return tokens[0];
          fail();
        }
        // A fallback role can leave the native semantics in force.
      }
      if (tag === 'button') return 'button';
      if (tag === 'select') return !el.multiple && el.size <= 1 ? 'combobox' : undefined;
      if (tag === 'input') {
        if (['checkbox','radio'].includes(el.type)) return el.type;
        if (['button','submit','reset'].includes(el.type)) return 'button';
        if (['image','file','color','date','datetime-local','month','week','time'].includes(el.type) ||
            (relevant.has('combobox') && el.hasAttribute('list'))) fail();
      }
      if (tag === 'summary') fail();
      if (['ul','ol','menu'].includes(tag)) return 'list';
      if (tag === 'fieldset') return 'group';
      if (relevant.has('group') && ['details','optgroup','audio','video','address','hgroup'].includes(tag)) fail();
    };
    const norm = text => text.trim().replace(/\s+/g, ' ');
    const simpleText = (root, skip) => {
      const text = el => {
        const style = getComputedStyle(el);
        if (['::before','::after'].some(p => !['none','normal'].includes(getComputedStyle(el,p).content)) ||
            style.textTransform !== 'none' || style.visibility !== 'visible' ||
            !['normal','nowrap'].includes(style.whiteSpace) || el.matches('[aria-hidden="true" i]')) fail();
        return Array.from(el.childNodes, n => {
          if (n === skip || decorative.has(n) || n.nodeType === Node.COMMENT_NODE) return '';
          if (n.nodeType === Node.TEXT_NODE) return n.data;
          // Adjacent plain inline text combines without layout-generated separators.
          if (!n.matches?.('span,b,strong,small,i,em') || getComputedStyle(n).display !== 'inline' ||
              n.hasAttribute('role') || n.hasAttribute('title') || n.getAttributeNames().some(a => a.startsWith('aria-'))) fail();
          return text(n);
        }).join('');
      };
      return norm(text(root));
    };
    const name = el => {
      if (el.hasAttribute('aria-labelledby') || el.ariaLabelledByElements?.length) fail();
      const aria = el.getAttribute('aria-label');
      if (aria?.trim()) return norm(aria);
      if (el.labels?.length) {
        if (el.labels.length !== 1) fail();
        return simpleText(el.labels[0], el) || norm(el.title || '');
      }
      if (el.localName === 'input' && ['button','submit','reset'].includes(el.type)) {
        // The browser supplies a localized name for some empty values.
        if (!el.value.trim()) fail();
        return norm(el.value);
      }
      if (el.localName === 'button' || el.getAttribute('role') === 'button') return simpleText(el) || norm(el.title || '');
      if (el.localName === 'fieldset' && el.querySelector('legend')) fail();
      return norm(el.title || '');
    };
    const visible = el => {
      // display:none (including its ancestors) excludes the subtree from AX. For other
      // visibility semantics we cannot establish from layout alone, do not omit a peer.
      for (let p = el; p; p = p.parentElement) if (getComputedStyle(p).display === 'none') return false;
      if (getComputedStyle(el).visibility !== 'visible' || el.closest('[inert],[aria-hidden="true" i],details:not([open])') ||
          !el.getClientRects().length) fail();
      for (let p = el; p; p = p.parentElement) if (getComputedStyle(p).contentVisibility !== 'visible') fail();
      return true;
    };
    const pool = [];
    for (const el of all) {
      if (excluded(el)) continue;
      const role = supported(el);
      if (!relevant.has(role) || !visible(el)) continue;
      if (el.hasAttribute('role') && el.getAttribute('role') !== role) fail();
      if (el.hasAttribute('role') && !['list','group','button'].includes(role) && !el.getAttribute('aria-label')?.trim()) fail();
      pool.push({ el, role, name:name(el) });
    }
    const peerRoles = ${JSON.stringify(peers.map(r => r.role))};
    const liveRoles = new Map(pool.map(p => [p.el, p.role]));
    if (peerRoles.some((role,i) => liveRoles.get(els[rows.length + i]) !== role)) return {};
    const resolve = loc => pool.filter(p => p.role === loc.role && p.name === loc.name).map(p => p.el);
    const same = (live, indexes) => live.length === indexes.length && live.every((el,i) => el === els[indexes[i]]);
    if (!same(resolve(scope.target), targets) || pool.some(p => p.role === scope.target.role &&
        p.name !== scope.target.name && p.name.toLowerCase() === scope.target.name.trim().toLowerCase())) return {};
    for (const [i, p] of scope.prerequisites.entries()) {
      const g = groups[i];
      if (!p.container) { if (!same(resolve(p), g.members)) return {}; continue; }
      if (!same(resolve(p.container), [g.root])) return {};
      const descendants = pool.filter(n => n.role === p.memberRole && els[g.root].contains(n.el));
      if (!same(descendants.map(n => n.el), g.members) ||
          descendants.some((n,j) => n.name !== rows[g.members[j]].name)) return {};
    }
    const key = Symbol.for(guardKey + ':scope-identities');
    const store = globalThis[key] ??= {document, ids:new WeakMap(), next:0,
      token:Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-')};
    if (store.document !== document) return {};
    const id = el => {
      if (!store.ids.has(el)) store.ids.set(el, String(++store.next));
      return store.ids.get(el);
    };
    const facts = (${DOM_FOREGROUND_PROBE})(...targets.map(i => els[i]));
    const targetFacts = new Map(targets.map((i, position) => [i, facts[position]]));
    const node = i => {
      const el = els[i], {role, name} = rows[i], target = targetFacts.get(i), ax = states[i];
      // Only native controls with a known state contract. Custom widgets or additional
      // ARIA states (e.g. a toggle button) must not be reported as unchanged.
      if (el.hasAttribute('role') || el.getAttributeNames().some(attr => attr.startsWith('aria-') &&
          !['aria-label','aria-labelledby','aria-disabled','aria-hidden'].includes(attr))) return;
      const disabled = el.matches(':disabled') || !!el.closest('[aria-disabled="true" i],[inert]');
      const result = {id:id(el), role, name, disabled};
      if (disabled !== ax.disabled) return;
      if (target) {
        if (el.tagName !== 'BUTTON') return;
        if (targets.length > 1) return result;
        if (typeof target.occluded !== 'boolean' || (${!!listing} && (target.occluded !== ax.occluded ||
            (target.inActivePopup === true) !== ax.inActivePopup))) return;
        return {...result, occluded:target.occluded, inActivePopup:target.inActivePopup === true};
      }
      if (role === 'combobox' && el.tagName === 'SELECT' && !el.multiple && el.size <= 1) {
        const option = el.selectedOptions[0];
        // Form properties can change without a MutationObserver record. Bind the live value
        // to the captured AX label; two options with that label cannot establish this.
        if (!option || option.label !== ax.value || el.options.length > 4096 ||
            Array.from(el.options).some(o => o !== option && o.label === option.label)) return;
        return {...result, value:JSON.stringify([el.value, el.selectedIndex, option.label])};
      }
      if ((role === 'checkbox' || role === 'radio') && el.tagName === 'INPUT' && el.type === role) {
        const checked = el.indeterminate ? 'mixed' : el.checked;
        // Mixed AX state does not expose the native checked bit submitted by a form.
        if (checked === ax.checked) return {...result, value:el.value, checked:el.checked, indeterminate:el.indeterminate};
      }
    };
    const prerequisites = [];
    for (const g of groups) {
      const members = g.members.map(node);
      if (members.some(n => !n)) return {};
      if (g.root === undefined) { prerequisites.push({members}); continue; }
      const root = els[g.root];
      if (root.closest('[aria-busy="true" i],[inert]')) return {};
      // A DOM walk must recover every AX member, in the same order. Refuse explicit
      // partial/virtual sets and descendants whose contents light DOM cannot establish.
      if (root.matches('[aria-posinset],[aria-setsize],[aria-rowcount]') ||
          root.querySelector('[aria-busy="true" i],[aria-posinset],[aria-setsize],[aria-rowcount]')) return {};
      // Even an AX-hidden checkbox inside the declared set makes full membership
      // unverifiable; do not silently substitute only the rendered part of a set.
      if (Array.from(root.querySelectorAll('input[type="checkbox" i],[role~="checkbox" i]'))
          .filter(el => !excluded(el)).length !== g.members.length) return {};
      prerequisites.push({containerId:id(root), members});
    }
    const measured = targets.map(node);
    if (measured.some(n => !n)) return {};
    return {complete:true, documentId:store.token, targets:measured, prerequisites};
  }`;
  const uids = [...nodes, ...peers].map(r => r.uid);
  return { uid: targetRows.length === 1 ? targetRows[0]!.uid : undefined, measure: async () => {
    const facts = extractFirstJsonObject(await evaluate(source, uids)) as PageGuidanceScopeFacts | undefined;
    return facts?.complete === true ? facts : undefined;
  } };
}
