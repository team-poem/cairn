/** Browser-context function source, shared by DOM-based adapters without MCP dependencies.
 * Internal implementation, not a public package API. Evaluate once per document-local batch
 * with exact nodes; never resolve membership by accessible name. All caches die with the call. */
export const DOM_FOREGROUND_PROBE = String.raw`(...nodes) => {
  const styles = new Map(), boxes = new Map(), visibility = new Map(), topLayers = new Map();
  const style = el => {
    if (!styles.has(el)) styles.set(el, getComputedStyle(el));
    return styles.get(el);
  };
  const box = el => {
    if (!boxes.has(el)) boxes.set(el, el.getBoundingClientRect());
    return boxes.get(el);
  };
  const topLayer = el => {
    if (!topLayers.has(el)) {
      let result = false;
      try { result = el.matches(':modal'); } catch { /* Older browser. */ }
      try { result = result || el.matches(':popover-open'); } catch { /* Older browser. */ }
      topLayers.set(el, result);
    }
    return topLayers.get(el);
  };
  const visible = el => {
    if (!el || el.nodeType !== 1 || !el.isConnected || el.getRootNode() !== document) return false;
    if (visibility.has(el)) return visibility.get(el);
    // Computed visibility already resolves inheritance and explicit descendant overrides.
    // It is not an irreversible ancestor/subtree property like display:none.
    const own = style(el);
    let result = own.visibility !== 'hidden' && own.visibility !== 'collapse';
    let escaped = false;
    for (let p = el; p; p = p.parentElement) {
      const cs = style(p);
      // Top-layer boxes escape ancestor opacity, but display:none still suppresses layout.
      // Keep aria-hidden exclusion independent of painting and of the top-layer boundary.
      if (cs.display === 'none' || (!escaped && Number(cs.opacity) === 0) ||
          p.getAttribute('aria-hidden') === 'true') { result = false; break; }
      if (topLayer(p)) escaped = true;
    }
    visibility.set(el, result);
    return result;
  };
  const clipping = (el, x, y) => {
    let outside = false;
    for (let p = el; p; p = p.parentElement) {
      const cs = style(p);
      // Nonrectangular clips are not established by a bounding box.
      if (cs.clipPath !== 'none' || (cs.clip !== 'auto' && cs.clip !== '')) return { uncertain: true, outside };
      // Root overflow propagates to the viewport. A zero-height scroll-locked body does not
      // clip its fixed dialog to that body's layout box; viewport bounds are checked below.
      if (p !== el && p !== document.body && p !== document.documentElement) {
        const b = box(p);
        if (/(auto|scroll|overlay|hidden|clip)/.test(cs.overflowX) && (x < b.left || x >= b.right)) outside = true;
        if (/(auto|scroll|overlay|hidden|clip)/.test(cs.overflowY) && (y < b.top || y >= b.bottom)) outside = true;
      }
      // The top-layer root's own clipping still applies to its descendants, not its ancestors'.
      if (topLayer(p)) break;
    }
    return { uncertain: false, outside };
  };
  const active = new Set();
  const add = el => {
    if (visible(el) && el.getClientRects().length) active.add(el);
  };
  const popupRole = el => /^(dialog|alertdialog|listbox|menu|tree|grid)$/.test(el.getAttribute('role') || '');
  // One semantic scan per batch, not per candidate. A disclosure controls a region but does
  // not establish popup semantics. Standalone listboxes likewise need an expanded controller.
  for (const el of document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-expanded="true"]')) {
    if (el.matches('dialog[open], [role="dialog"], [role="alertdialog"]')) add(el);
    if (el.getAttribute('aria-expanded') !== 'true' || !visible(el)) continue;
    for (const attr of ['aria-controls', 'aria-owns']) {
      for (const id of (el.getAttribute(attr) || '').split(/\s+/)) {
        const root = id && document.getElementById(id);
        if (root && popupRole(root)) add(root);
      }
    }
  }
  try {
    for (const el of document.querySelectorAll(':popover-open')) add(el);
  } catch { /* Engines without popovers still support the semantic paths. */ }

  // Conservative fallback: a near-viewport fixed layer must actually intercept several
  // spread-out hit-test rays above independent rendered content. Size/position alone is not
  // evidence: headers, sidebars, click-through layers and a lone fullscreen app abstain.
  const visited = new Set();
  for (const raw of nodes) {
    let el = raw && raw.nodeType === 3 ? raw.parentElement : raw;
    if (!el || el.nodeType !== 1 || el.getRootNode() !== document) continue;
    for (; el && !visited.has(el); el = el.parentElement) {
      visited.add(el);
      if (active.has(el) || el === document.body || el === document.documentElement || !visible(el)) continue;
      const cs = style(el);
      if (cs.position !== 'fixed' || cs.pointerEvents === 'none') continue;
      const b = box(el);
      const left = Math.max(0, b.left), top = Math.max(0, b.top);
      const width = Math.min(innerWidth, b.right) - left, height = Math.min(innerHeight, b.bottom) - top;
      if (width < innerWidth * 0.8 || height < innerHeight * 0.8 || width <= 0 || height <= 0) continue;
      let evidence = 0;
      for (const [fx, fy] of [[0.1, 0.1], [0.9, 0.1], [0.5, 0.5], [0.1, 0.9], [0.9, 0.9]]) {
        const x = left + width * fx, y = top + height * fy;
        if (clipping(el, x, y).uncertain) continue;
        const stack = document.elementsFromPoint(x, y);
        if (!stack.length || !el.contains(stack[0])) continue;
        if (stack.some(under => under !== document.body && under !== document.documentElement &&
            !el.contains(under) && !under.contains(el) && visible(under))) evidence++;
      }
      if (evidence >= 3) active.add(el);
    }
  }

  return nodes.map(raw => {
    const el = raw && raw.nodeType === 3 ? raw.parentElement : raw;
    const facts = {};
    if (!visible(el)) return facts;
    const b = box(el), x = b.left + b.width / 2, y = b.top + b.height / 2;
    if (!b.width || !b.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return facts;
    const clip = clipping(el, x, y);
    if (clip.uncertain) return facts;
    const hit = document.elementFromPoint(x, y);
    if (!hit) return facts;
    // A positive exact hit establishes that positioned content escaped any intervening
    // non-containing overflow ancestors. A miss outside a possible clip stays unknown:
    // do not mistake genuinely clipped content for another element covering it.
    if (hit !== el && !el.contains(hit) && clip.outside) return facts;
    facts.occluded = hit !== el && !el.contains(hit);
    // Covered parent controls and offscreen descendants do not inherit popup priority.
    if (!facts.occluded) {
      for (let p = el; p; p = p.parentElement) {
        if (active.has(p)) { facts.inActivePopup = true; break; }
      }
    }
    return facts;
  });
}`;
