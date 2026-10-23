/** A host-created capability shared with its DOM injection and browser adapter.
 * The scripts take an exact Element, not a selector or a page-supplied ownership attribute.
 * This is cooperative host instrumentation isolation, not a security sandbox for hostile JS. */
export interface HostOwnedRootScope {
  readonly key: string;
  readonly registerScript: string;
  readonly unregisterScript: string;
}

/** Internal browser-context implementation. No Node imports; caches are document-scoped. */
export const HOST_ROOT_REGISTRY = String.raw`key => {
  const symbol = Symbol.for(key);
  const previous = globalThis[symbol];
  if (previous?.document === document) return previous;
  previous?.dispose?.();
  const roots = new Map();
  const token = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
  let revision = 0;
  const ancestors = node => {
    const result = [];
    for (let p = node; p; p = p.parentNode || p.host) result.push(p);
    return result;
  };
  const update = records => {
    const removed = records.flatMap(record => [...record.removedNodes]);
    for (const [root, chain] of roots) {
      // Reattachment, even before observer delivery, does not silently reacquire ownership.
      if (!root.isConnected || root.ownerDocument !== document || removed.some(node => chain.includes(node))) {
        roots.delete(root); revision++;
      } else roots.set(root, ancestors(root));
    }
    if (!roots.size) observer.disconnect();
  };
  const observer = new MutationObserver(update);
  const refresh = () => update(observer.takeRecords());
  const owns = node => {
    for (let p = node; p; p = p.parentNode || p.host) if (roots.has(p)) return true;
    return false;
  };
  const related = node => owns(node) || [...roots.keys()].some(root => ancestors(root).includes(node));
  const excluded = (raw, textOnly = false) => {
    // A Text node owns only its own text. Its parent's aggregate accessibility name
    // may depend on a sibling host root, but that does not make this text host-owned.
    if (raw?.nodeType === 3) {
      if (!raw.isConnected || raw.ownerDocument !== document) throw new Error('Host ownership node unavailable');
      return owns(raw);
    }
    const el = raw;
    if (el === document) return false;
    if (!el || el.nodeType !== 1 || !el.isConnected || el.ownerDocument !== document) throw new Error('Host ownership node unavailable');
    // MCP resolves StaticText to its parent Element, not the actual Text object.
    // The adapter supplies the captured AX role so those rows retain text ownership
    // rather than accidentally inheriting their parent's aggregate-name dependencies.
    if (textOnly) return owns(el);
    if (related(el)) return true;
    // Do not let a parent name or an external label derived from owned UI satisfy a text check.
    // Omit ambiguous rows rather than inventing an accessibility name by subtracting strings.
    const pending = [el], visited = new Set(), references = new Set();
    while (pending.length) {
      const node = pending.pop();
      if (visited.has(node)) continue;
      visited.add(node);
      // Names can come from descendants, including descendants of an external native
      // label. Do not attempt to reconstruct the browser's accessible-name algorithm:
      // conservatively reject any such dependency on owned content.
      for (const child of node.children) pending.push(child);
      const dependencies = [...(node.labels || [])];
      for (const [attr, property] of [
        ['aria-labelledby', 'ariaLabelledByElements'],
        ['aria-describedby', 'ariaDescribedByElements'],
        ['aria-owns', 'ariaOwnsElements'],
      ]) {
        // Reflected element references can leave the corresponding attribute empty.
        for (const label of node[property] || []) dependencies.push(label);
        for (const id of (node.getAttribute(attr) || '').split(/\s+/)) {
          const label = id && node.getRootNode().getElementById?.(id);
          if (label) dependencies.push(label);
        }
      }
      for (const label of dependencies) {
        if (related(label)) return true;
        references.add(label);
        // Bound cross-node reference graphs, not ordinary subtree size. A large app
        // region with no label references must not fail just because it has many children.
        if (references.size > 256) throw new Error('Host ownership label graph exceeds supported bounds');
        if (label !== node) pending.push(label);
      }
    }
    return false;
  };
  const state = {
    document, owns, excluded,
    status() {
      refresh();
      return { stamp: token + ':' + revision, active: roots.size,
        unsupported: roots.size > 0 && (window.top !== window || !!document.querySelector('iframe,frame')) };
    },
    register(root) {
      refresh();
      if (window.top !== window || !root || root.nodeType !== 1 || !root.isConnected ||
          root.getRootNode() !== document || root === document.body || root === document.documentElement) {
        throw new Error('Register a connected, non-document host Element in the top-level light DOM');
      }
      if (!roots.has(root)) { roots.set(root, ancestors(root)); revision++; }
      observer.observe(document, {subtree:true,childList:true});
      return state.status();
    },
    unregister(root) {
      refresh();
      if (roots.delete(root)) revision++;
      if (!roots.size) observer.disconnect();
      return state.status();
    },
    dispose() { observer.disconnect(); roots.clear(); revision++; }
  };
  globalThis[symbol] = state;
  return state;
}`;

export function createHostOwnedRootScope(): HostOwnedRootScope {
  // getRandomValues is also available to browser embeddings on non-secure HTTP origins;
  // randomUUID is not. This is a collision-resistant scope ID, not a security boundary.
  const key = `cairn:host-roots:${Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)),
    word => word.toString(16).padStart(8, "0")).join("-")}`;
  const script = (method: string) => `(root) => (${HOST_ROOT_REGISTRY})(${JSON.stringify(key)}).${method}(root)`;
  return Object.freeze({ key, registerScript: script("register"), unregisterScript: script("unregister") });
}
