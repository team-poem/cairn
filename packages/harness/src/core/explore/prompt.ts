/**
 * The explore loop's LLM-facing surface: an explorer persona over the SAME action vocabulary as
 * discover (one shared definition, no drift — #99) plus the explore-only `note`, and per-turn
 * prompt assembly with coverage memory. Pure — no driver, no I/O.
 */
import type { Step } from "../types.js";
import { ACTION_RULES, ACTION_VOCABULARY, PERCEPTION_RULES } from "../discover/prompt.js";
import type { Finding } from "./findings.js";

export const EXPLORE_SYSTEM =
  "You are an exploratory QA agent driving a web browser to survey a web app for problems a real user would hit, guided by a charter. " +
  PERCEPTION_RULES +
  ACTION_VOCABULARY +
  ' · {"action":"note","severity":"info|warn|error","text":"<the problem>"} ' +
  "(record a UX problem you observe — a confusing state, a dead end, misleading copy, a broken flow; it does not touch the page) · " +
  '{"action":"done"}. ' +
  ACTION_RULES +
  "Prefer destinations you have NOT visited over re-walking covered ground. " +
  'Use "note" whenever something would confuse or annoy a real user — recording problems is the mission, not a side effect — but never re-note a problem already recorded. ' +
  'Use "done" when the charter is covered: the distinct areas are visited and nothing new is left to try.';

export function buildExplorePrompt(
  charter: string,
  render: string,
  prevRender: string,
  steps: Step[],
  failures: string[],
  visited: readonly string[],
  findings: readonly Finding[],
  currentUrl?: string,
): string {
  const history = steps.length
    ? steps.map((s, i) => `${i + 1}. ${JSON.stringify(s)}`).join("\n")
    : "(none yet)";
  // #15 — a stable page between steps doesn't need the whole list re-sent.
  const elementsBlock =
    render && render === prevRender ? "(unchanged from previous step)" : render || "(none)";
  return [
    `Charter: ${charter}`,
    `Current page: ${currentUrl ?? "(unknown)"}`,
    ``,
    // Coverage memory — the explore mirror of discover's failure memory: what is already walked,
    // so the model spends its steps on new ground instead of circling.
    `Destinations already visited (prefer NEW ground):`,
    ...(visited.length ? visited.map((v) => `- ${v}`) : ["(none yet)"]),
    ``,
    ...(findings.length
      ? [
          `Problems already recorded (do NOT re-note these):`,
          ...findings.map((f) => `- [${f.severity}] ${f.key.slice(0, 120)}`),
          ``,
        ]
      : []),
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
