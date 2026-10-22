/** Fixed-size, content-free summaries. Never use a page-supplied string as a payload key. */
import type { PageElement } from "./types.js";

export interface CandidateCounts {
  count: number;
  roles: { button: number; link: number; input: number; choice: number; text: number; other: number };
}

export interface SelectionSummary {
  raw: CandidateCounts;
  perceived: CandidateCounts;
  eligible: CandidateCounts;
  selected: CandidateCounts;
  excluded: { occluded: number; clickableRegionOrQuota: number };
  capOmitted: number;
}

export interface SelectionDiagnostic extends SelectionSummary {
  /** Prepared input is NOT proof of model admission, a wire request, or an executed action. */
  stage: "prepared";
  observationId: string;
  decisionId: string;
  purpose: "discover" | "explore" | "locator-heal" | "step-heal";
}

export function candidateCounts(elements: readonly PageElement[]): CandidateCounts {
  const roles: CandidateCounts["roles"] = { button: 0, link: 0, input: 0, choice: 0, text: 0, other: 0 };
  for (const { role } of elements) {
    switch (role) {
      case "button": roles.button++; break;
      case "link": roles.link++; break;
      case "textbox": case "searchbox": case "spinbutton": roles.input++; break;
      case "checkbox": case "radio": case "combobox": case "listbox": case "option":
      case "switch": case "slider": case "tab": case "menuitem": case "menuitemcheckbox":
      case "menuitemradio": roles.choice++; break;
      case "StaticText": case "text": case "paragraph": case "heading": roles.text++; break;
      default: roles.other++;
    }
  }
  return { count: elements.length, roles };
}
