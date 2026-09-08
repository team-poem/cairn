/** Browser-neutral policy over Driver observation facts. No DOM or driver handles. */
import type { PageElement } from "./types.js";

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "option",
  "listbox",
  "searchbox",
  "slider",
  "spinbutton",
]);

/** Cap slots reserved for intent-matching NON-interactive text (#115): the "what happened"
 * evidence — a success confirmation, an error banner — that interactive-first scoring would rank
 * out on a heavy page, leaving the model unable to see the goal was reached and say done. */
const EVIDENCE_SLOTS = 5;

/**
 * #15 — rank the snapshot before the cutoff so it keeps what matters on a heavy page: interactive
 * controls first, then intent-relevant names. A flat `slice(0, N)` can drop the one control a flow
 * needs when a page has thousands of elements (seen in dogfooding) — ranking is correctness, not just cost.
 * Up to EVIDENCE_SLOTS of the cap are reserved for intent-matching non-interactive text (#115);
 * with no such matches (or when they fit anyway) the ranking is unchanged.
 */
export function rankElements(
  elements: PageElement[],
  intent: string,
  limit: number,
): PageElement[] {
  // Unicode-aware tokens — `\W` treats every Korean (or any non-ASCII) char as a separator, so a
  // Korean intent yielded no tokens and ranked nothing by relevance (P8). Match letter/number runs.
  const words = (intent.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 2);
  const scored = elements
    .filter((e) => e.occluded !== true)
    .map((e, i) => {
      const interactive = INTERACTIVE_ROLES.has(e.role) || e.clickable === true;
      let score = interactive ? 100 : 0;
      const name = e.name.toLowerCase();
      for (const w of words) if (name.includes(w)) score += 10;
      return { e, score, i, evidence: !interactive && score > 0 };
    })
    .sort((a, b) => Number(b.e.inActivePopup === true) - Number(a.e.inActivePopup === true) || b.score - a.score || a.i - b.i);

  const cut = scored.slice(0, limit);
  const missed = scored.slice(limit).filter((s) => s.evidence).slice(0, EVIDENCE_SLOTS);
  if (!missed.length) return cut.map((s) => s.e);

  // Evict the lowest-ranked non-evidence rows to make room, then restore rank order.
  const evicted = new Set<(typeof cut)[number]>();
  for (let i = cut.length - 1; i >= 0 && evicted.size < missed.length; i--) {
    if (!cut[i]!.evidence) evicted.add(cut[i]!);
  }
  return [...cut.filter((s) => !evicted.has(s)), ...missed]
    .sort((a, b) => Number(b.e.inActivePopup === true) - Number(a.e.inActivePopup === true) || b.score - a.score || a.i - b.i)
    .map((s) => s.e);
}

const MAX_SUPPLEMENTARY_CLICKABLES = 40;

/** Keep one proven clickable label per region without deleting the other text evidence. */
export function normalizeElements(elements: PageElement[]): PageElement[] {
  const seen = new Set<string>();
  let promoted = 0;
  return elements.map((element) => {
    if (!element.clickable) return element;
    if (promoted >= MAX_SUPPLEMENTARY_CLICKABLES || (element.clickableRegion && seen.has(element.clickableRegion))) {
      return { ...element, clickable: false };
    }
    if (element.clickableRegion) seen.add(element.clickableRegion);
    promoted++;
    return element;
  });
}
