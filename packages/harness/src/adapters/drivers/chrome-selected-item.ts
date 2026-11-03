/** Explicit resource-key reads for selected-item evidence; no URL or label inference. */
import { extractFirstJsonObject } from "../../core/json.js";
import type { DestinationResourceKey, ResourceKeyObservation, SelectedItemKey } from "../../core/selected-item-evidence.js";
import { HOST_ROOT_REGISTRY } from "./host-owned-roots.js";

type Call = (name: string, args?: Record<string, unknown>) => Promise<string>;
let nextReceipt = 0;
const attributeName = /^data-[a-z][a-z0-9-]*$/;

export interface SelectedItemReceipt {
  finish(): Promise<ResourceKeyObservation>;
  dispose(): Promise<void>;
}

/** The event confirms a pre-action read. It neither changes nor retries the browser action.
 * A full navigation loses this document-local receipt and deliberately yields no evidence. */
export async function prepareSelectedItemReceipt(
  call: Call, guardKey: string, collectionKey: string, uid: string, source: SelectedItemKey,
  hostKey?: string, hostStamp?: string,
): Promise<SelectedItemReceipt> {
  const key = `cairn-selected-item:${collectionKey}:${nextReceipt++}`;
  let value: string | undefined, disposed = false;
  const cleanup = `const key = Symbol.for(${JSON.stringify(key)}); const receipt = globalThis[key];
    receipt?.dispose?.(); delete globalThis[key];`;
  const dispose = async () => {
    if (disposed) return;
    await call("evaluate_script", { function: `() => { ${cleanup} return {}; }` });
    disposed = true;
    value = undefined;
  };
  if (source.kind === "attribute" && ["item", "action"].includes(source.scope) && attributeName.test(source.attribute)) {
    let raw: ResourceKeyObservation | undefined;
    try {
      raw = extractFirstJsonObject(await call("evaluate_script", {
      args: [uid],
      function: `(action) => {
        const state = globalThis[Symbol.for(${JSON.stringify(guardKey)})];
        const saved = state?.collections?.get(${JSON.stringify(collectionKey)});
        const index = saved?.actions.indexOf(action) ?? -1;
        if (window.top !== window || !state?.observer || state.overflow || index < 0) return {complete:false};
        const source = ${JSON.stringify(source)};
        const item = saved.members[index], node = source.scope === 'item' ? item : action;
        const value = node?.getAttribute(source.attribute);
        if (typeof value !== 'string' || !value.trim() || value.length > 256) return {complete:false};
        const registry = ${hostKey ? `(${HOST_ROOT_REGISTRY})(${JSON.stringify(hostKey)})` : "null"};
        const element = node => node?.nodeType === 3 ? node.parentElement : node;
        const disabled = el => {
          for (let p = el; p; p = p.parentElement)
            if (p.matches(':disabled') || p.getAttribute('aria-disabled') === 'true') return true;
          return false;
        };
        const conditions = () => saved.conditions.map(raw => {
          const el = element(raw), out = {disabled:disabled(el)};
          if (typeof el.value === 'string') out.value = el.value;
          else if (el.hasAttribute('aria-valuetext')) out.value = el.getAttribute('aria-valuetext');
          else if (el.hasAttribute('aria-sort')) out.value = el.getAttribute('aria-sort');
          if (el.matches('input[type=checkbox],input[type=radio]')) out.checked = el.indeterminate ? 'mixed' : el.checked;
          else if (el.getAttribute('aria-checked') === 'mixed') out.checked = 'mixed';
          else if (['true','false'].includes(el.getAttribute('aria-checked'))) out.checked = el.getAttribute('aria-checked') === 'true';
          return out;
        });
        const unchanged = () => {
          if (globalThis[Symbol.for(${JSON.stringify(guardKey)})] !== state ||
              state.collections?.get(${JSON.stringify(collectionKey)}) !== saved || state.overflow) return false;
          state.retain(state.observer.takeRecords());
          const scopes = [saved.root, ...saved.conditions.map(element)];
          const touches = node => scopes.some(scope => scope === node || scope.contains(node) || node.contains?.(scope));
          if (state.overflow || state.records.some(record => touches(record.target) ||
              (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(touches)))) return false;
          // ARIA element-reference properties can change without a mutation record. Repeat
          // the bounded incoming-ownership check at the event, including open shadow owners.
          const trees = [document];
          let ownershipWork = 0;
          const attributeTargets = (owner, value) => {
            if (value.length > 65536) return null;
            const tokens = value.trim() ? value.trim().split(/\\s+/) : [];
            ownershipWork += tokens.length;
            return tokens.map(id => owner.getRootNode().getElementById?.(id)).filter(Boolean);
          };
          while (trees.length) {
            const walk = document.createTreeWalker(trees.pop(), NodeFilter.SHOW_ELEMENT);
            for (let owner = walk.nextNode(); owner; owner = walk.nextNode()) {
              if (++ownershipWork > 16384) return false;
              if (owner.shadowRoot) trees.push(owner.shadowRoot);
              const attr = owner.getAttribute('aria-owns') || '';
              const refs = owner.ariaOwnsElements;
              const targets = attributeTargets(owner, attr);
              if (!targets || (refs != null && !Array.isArray(refs))) return false;
              ownershipWork += refs?.length || 0;
              if (ownershipWork > 16384) return false;
              if (targets.some(touches) || refs?.some(touches)) return false;
              const withinCollection = owner === saved.root || saved.root.contains(owner);
              // attachShadow() does not create a light-DOM mutation record. The event
              // must retain the same supported topology as the collection measurement.
              if ((withinCollection && (owner.shadowRoot || /^(IFRAME|FRAME)$/.test(owner.tagName) ||
                  owner.hasAttribute('aria-owns') || refs?.length)) ||
                  (scopes.includes(owner) && (targets.length || refs?.length))) return false;
            }
          }
          // An external owner can add and remove a relation before the event. Its
          // mutation target is outside the collection, but its previous targets are not.
          for (const record of state.records) {
            if (record.type !== 'attributes' || record.attributeName !== 'aria-owns') continue;
            const previous = attributeTargets(record.target, record.oldValue || '');
            if (!previous || ownershipWork > 16384 || previous.some(touches)) return false;
          }
          if (![saved.root, item, action, ...saved.conditions.map(element)].every(node => node?.isConnected && node.getRootNode() === document)) return false;
          if (saved.actions[index] !== action || saved.members[index] !== item ||
              node.getAttribute(source.attribute) !== value || disabled(item) || disabled(action) ||
              JSON.stringify(conditions()) !== JSON.stringify(saved.conditionFacts)) return false;
          const ownership = registry?.status();
          return !ownership?.unsupported && (!registry || ownership.stamp === ${JSON.stringify(hostStamp ?? null)}) &&
            !registry?.excluded(saved.root) && !registry?.excluded(action);
        };
        if (!unchanged()) return {complete:false};
        const key = Symbol.for(${JSON.stringify(key)});
        const receipt = {document, complete:false, observed:false, dispose:undefined};
        const listener = event => {
          if (!event.isTrusted || !event.composedPath().includes(action) || receipt.observed) return;
          receipt.observed = true;
          try { receipt.complete = unchanged(); } catch { receipt.complete = false; }
          // Keep pagehide cleanup until the host acknowledges the receipt. Removing only
          // this listener avoids retaining a live observer of later application clicks.
          window.removeEventListener('click', listener, true);
        };
        receipt.dispose = () => {
          window.removeEventListener('click', listener, true);
          window.removeEventListener('pagehide', receipt.dispose, true);
          delete globalThis[key];
        };
        globalThis[key] = receipt;
        window.addEventListener('click', listener, true);
        // Runs in the source document even when it enters the back/forward cache.
        window.addEventListener('pagehide', receipt.dispose, true);
        return {complete:true,value};
      }`,
      })) as ResourceKeyObservation | undefined;
    } catch (error) {
      // The browser may have installed the listener before its response was interrupted.
      await dispose().catch(() => {});
      throw error;
    }
    if (raw?.complete === true && typeof raw.value === "string" && raw.value.trim() && raw.value.length <= 256) value = raw.value;
  }
  return {
    dispose,
    async finish() {
      if (disposed) return { complete: false };
      if (value === undefined) { await dispose(); return { complete: false }; }
      const raw = extractFirstJsonObject(await call("evaluate_script", {
        function: `() => { ${cleanup}
          return {complete:receipt?.document === document && receipt.observed === true && receipt.complete === true}; }`,
      })) as { complete?: unknown } | undefined;
      const result = raw?.complete === true ? { complete: true, value } : { complete: false };
      disposed = true;
      value = undefined;
      return result;
    },
  };
}

/** Single explicitly configured light-DOM node, bounded traversal and bounded value. */
export function resourceKeyScript(destination: DestinationResourceKey, hostKey?: string): string {
  return `() => {
    const spec = ${JSON.stringify(destination)};
    if (window.top !== window || spec.kind !== 'attribute' ||
        typeof spec.selector !== 'string' || !spec.selector.trim() || spec.selector.length > 512 ||
        typeof spec.attribute !== 'string' || !/^data-[a-z][a-z0-9-]*$/.test(spec.attribute)) return {complete:false};
    const registry = ${hostKey ? `(${HOST_ROOT_REGISTRY})(${JSON.stringify(hostKey)})` : "null"};
    const ownership = registry?.status();
    if (ownership?.unsupported) return {complete:false};
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
    let selected, count = 0;
    try {
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (++count > 16384) return {complete:false};
        if (!node.matches(spec.selector)) continue;
        if (selected) return {complete:false};
        selected = node;
      }
      if (!selected || selected.getRootNode() !== document || !selected.isConnected || registry?.excluded(selected)) return {complete:false};
      const value = selected.getAttribute(spec.attribute);
      if (typeof value !== 'string' || !value.trim() || value.length > 256 ||
          (registry && registry.status().stamp !== ownership.stamp)) return {complete:false};
      return {complete:true,value};
    } catch { return {complete:false}; }
  }`;
}
