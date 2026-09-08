/** Browser-neutral policy over Driver observation facts. No DOM or driver handles. */
import type { PageElement } from "./types.js";

/** Keep one proven clickable label per region without deleting the other text evidence. */
export function normalizeElements(elements: PageElement[]): PageElement[] {
  const seen = new Set<string>();
  return elements.map((element) => {
    if (!element.clickable || !element.clickableRegion) return element;
    if (seen.has(element.clickableRegion)) return { ...element, clickable: false };
    seen.add(element.clickableRegion);
    return element;
  });
}
