/**
 * The discover loop's LLM-facing surface: the system prompt (the closed action vocabulary),
 * snapshot ranking (#15), and per-turn prompt assembly. Pure — no driver, no I/O.
 */
import type { PageElement, Step } from "../types.js";

export const SYSTEM =
  "You are a QA agent driving a web browser to satisfy a natural-language intent. " +
  "At each turn you see the page's interactive elements and the actions taken so far. " +
  "Respond with ONE next action as strict JSON, no prose, no code fences. " +
  "Actions: " +
  '{"action":"click","text":"<element>"} · {"action":"doubleClick","text":"<element>"} · ' +
  '{"action":"hover","text":"<element>"} (reveals flyout/dropdown menus) · ' +
  '{"action":"type","text":"<element>","value":"<text>"} · {"action":"select","text":"<element>","value":"<option>"} · ' +
  '{"action":"pressKey","key":"Enter|Escape|Tab|..."} · {"action":"scroll","direction":"down|up"} (load lazy content) · ' +
  '{"action":"goto","url":"<url>"} · ' +
  '{"action":"waitFor","until":{"url":"<substring>"}|{"requestStatus":{"urlIncludes":"<substring>","status":200}}|{"text":"<element>"}} ' +
  "(block until the app is ready before the next step — e.g. an auth redirect lands or a key request returns — instead of racing it) · " +
  '{"action":"done"}. ' +
  'Always add "reason":"<short>". Use the exact element name shown. To open a menu before clicking a hidden item, hover it first. ' +
  'Use "done" when the intent is achieved (or impossible); with "done" you may include "assertions": an array of ' +
  '{"kind":"navigated"} | {"kind":"no-failed-requests"} | {"kind":"no-console-errors"} | {"kind":"request-status","urlIncludes":"...","status":200}.';

export const ELEMENT_LIMIT = 60;

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
  "searchbox",
  "slider",
  "spinbutton",
]);

/**
 * #15 — rank the snapshot before the cutoff so it keeps what matters on a heavy page: interactive
 * controls first, then intent-relevant names. A flat `slice(0, N)` can drop the one control a flow
 * needs when a page has thousands of elements (seen in dogfooding) — ranking is correctness, not just cost.
 */
export function rankElements(
  elements: PageElement[],
  intent: string,
  limit: number,
): PageElement[] {
  // Unicode-aware tokens — `\W` treats every Korean (or any non-ASCII) char as a separator, so a
  // Korean intent yielded no tokens and ranked nothing by relevance (P8). Match letter/number runs.
  const words = (intent.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 2);
  return elements
    .map((e, i) => {
      let score = INTERACTIVE_ROLES.has(e.role) ? 100 : 0;
      const name = e.name.toLowerCase();
      for (const w of words) if (name.includes(w)) score += 10;
      return { e, score, i };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i) // ranked, original order breaks ties (stable)
    .slice(0, limit)
    .map((s) => s.e);
}

export function renderElements(elements: PageElement[]): string {
  return elements.map((e) => `- [${e.role}] ${e.name}`).join("\n");
}

export function buildPrompt(
  intent: string,
  render: string,
  prevRender: string,
  steps: Step[],
  failures: string[],
): string {
  const history = steps.length
    ? steps.map((s, i) => `${i + 1}. ${JSON.stringify(s)}`).join("\n")
    : "(none yet)";
  // #15 — a stable page between steps doesn't need the whole list re-sent.
  const elementsBlock =
    render && render === prevRender ? "(unchanged from previous step)" : render || "(none)";
  return [
    `Intent: ${intent}`,
    ``,
    ...(failures.length
      ? [
          `These actions ALREADY FAILED — do NOT repeat them, choose a different element or approach:`,
          ...failures.map((f) => `- ${f}`),
          ``,
        ]
      : []),
    `Actions taken so far:`,
    history,
    ``,
    `Interactive elements now on the page:`,
    elementsBlock,
    ``,
    `What is the single next action? Respond with JSON only.`,
  ].join("\n");
}
