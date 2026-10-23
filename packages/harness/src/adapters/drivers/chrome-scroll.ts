import { HOST_ROOT_REGISTRY } from "./host-owned-roots.js";

/** Positive coverage only: the existing scroll verb affects the top-level window. Frames,
 * shadow trees, nested scroll regions, transformed/zoomed viewports and oversized DOMs abstain.
 * Fixed host UI is excluded; layout-participating host roots cannot supply app-only geometry. */
export function scrollStateScript(key: string, hostKey?: string): string {
  return `() => {
    const root = document.scrollingElement;
    if (window.top !== window || !root || !document.body || !document.documentElement ||
        (window.visualViewport && window.visualViewport.scale !== 1)) return {};
    const registry = ${hostKey ? `(${HOST_ROOT_REGISTRY})(${JSON.stringify(hostKey)})` : "null"};
    const status = registry?.status();
    if (status?.unsupported) return {};
    let unsupported = false, count = 0;
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (registry?.owns(el)) {
          if (getComputedStyle(el).position !== 'fixed') unsupported = true;
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let el = document.documentElement;
    do {
      if (++count > 4096 || el.shadowRoot || /^(IFRAME|FRAME)$/.test(el.tagName)) return {};
      const style = getComputedStyle(el);
      if (style.transform !== 'none' || ['translate', 'rotate', 'scale'].some(k => style[k] && style[k] !== 'none') ||
          (style.zoom && style.zoom !== '1' && style.zoom !== 'normal')) return {};
      if (el !== root &&
          ((/(auto|scroll|hidden)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1) ||
           (/(auto|scroll|hidden)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1))) return {};
      el = walker.nextNode();
    } while (el);
    if (unsupported) return {};
    const symbol = Symbol.for(${JSON.stringify(key)});
    let state = globalThis[symbol];
    if (!state || state.document !== document || state.root !== root) {
      state = { document, root, token: Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-') };
      globalThis[symbol] = state;
    }
    return { region: state.token + ':' + (status?.stamp ?? ''),
      x: root.scrollLeft, y: root.scrollTop,
      width: root.clientWidth, height: root.clientHeight,
      scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight };
  }`;
}
