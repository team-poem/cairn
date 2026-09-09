/** Pure ranking and clickable quota policy. No DOM access or driver handles. */
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
  // Positive occlusion is removed BEFORE clickable region allocation. Unknown stays eligible.
  const regions = new Set<string>();
  const candidates = elements.filter(e => {
    if (e.occluded === true) return false;
    if (!e.clickable || INTERACTIVE_ROLES.has(e.role)) return true;
    const region = e.clickableRegion;
    if (region !== undefined && regions.has(region)) return false;
    if (regions.size >= MAX_PROMOTED_CLICKABLES) return false;
    regions.add(region ?? `unmeasured:${elements.indexOf(e)}`);
    return true;
  });
  limit = Math.max(0, Math.floor(limit));
  // Unicode-aware tokens — `\W` treats every Korean (or any non-ASCII) char as a separator, so a
  // Korean intent yielded no tokens and ranked nothing by relevance (P8). Match letter/number runs.
  const words = (intent.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 2);
  const scored = candidates
    .map((e, i) => {
      const interactive = INTERACTIVE_ROLES.has(e.role) || e.clickable === true;
      let score = interactive ? 100 : 0;
      const name = e.name.toLowerCase();
      for (const w of words) if (name.includes(w)) score += 10;
      return { e, score, i, evidence: !interactive && words.some(w => name.includes(w)) };
    })
    .sort((a, b) => Number(b.e.inActivePopup === true) - Number(a.e.inActivePopup === true) || b.score - a.score || a.i - b.i); // ranked, original order breaks ties (stable)

  const cut = scored.slice(0, limit);
  const missed = scored.slice(limit).filter((s) => s.evidence).slice(0, EVIDENCE_SLOTS);
  if (!missed.length) return cut.map((s) => s.e);

  // Evict the lowest-ranked non-evidence rows to make room, then restore rank order.
  const evicted = new Set<(typeof cut)[number]>();
  for (let i = cut.length - 1; i >= 0 && evicted.size < missed.length; i--) {
    if (!cut[i]!.evidence) evicted.add(cut[i]!);
  }
  return [...cut.filter((s) => !evicted.has(s)), ...missed.slice(0, evicted.size)]
    .sort((a, b) => Number(b.e.inActivePopup === true) - Number(a.e.inActivePopup === true) || b.score - a.score || a.i - b.i)
    .map((s) => s.e);
}

const MAX_PROMOTED_CLICKABLES = 40;

/** Keep the first label per measured region, cap regions, then deduplicate names (#132). */
export function promotedClickableNames(
  candidates: { name: string }[],
  regions: unknown[],
): Set<string> {
  const firstPerRegion = new Map<number, string>();
  regions.forEach((rid, i) => {
    if (typeof rid === "number" && rid >= 0 && !firstPerRegion.has(rid)) {
      firstPerRegion.set(rid, candidates[i]!.name.trim());
    }
  });
  return new Set([...firstPerRegion.values()].slice(0, MAX_PROMOTED_CLICKABLES));
}
