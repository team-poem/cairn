/** Browser-neutral policy over Driver observation facts. No DOM or driver handles. */
import type { PageElement } from "./types.js";

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
