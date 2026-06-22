/**
 * The discover loop — the ONLY place the agent loops (invariant #3).
 *
 * Given an intent and an app it has never seen, it observes the page, asks the LLM for
 * the next action, acts, and re-observes until the intent is satisfied. The output is a
 * plain Scenario that can be frozen and later replayed deterministically with no LLM
 * (invariant #4). The LLM lives behind the LlmClient seam (invariant #5).
 */
import type { Driver } from "./ports.js";
import type { LlmClient } from "./ports.js";
import type { Assertion, PageElement, Scenario, Step } from "./types.js";

export interface DiscoverOptions {
  driver: Driver;
  llm: LlmClient;
  /** Optional starting URL. */
  baseUrl?: string;
  /** Safety cap on loop iterations. */
  maxSteps?: number;
  /** Called after each decision, for progress visibility. */
  onStep?: (decision: Decision, step?: Step) => void;
}

export interface Decision {
  action: "click" | "type" | "goto" | "done";
  text?: string;
  value?: string;
  url?: string;
  reason?: string;
  assertions?: Assertion[];
}

const SYSTEM =
  "You are a QA agent driving a web browser to satisfy a natural-language intent. " +
  "At each turn you see the page's interactive elements and the actions taken so far. " +
  "Respond with ONE next action as strict JSON, no prose, no code fences. " +
  'Schema: {"action":"click|type|goto|done","text":"<element name>","value":"<text to type>","url":"<url>","reason":"<short>"}. ' +
  'Use "click"/"type" with the exact element name shown. Use "done" when the intent is achieved; ' +
  'with "done" you may include "assertions": an array of {"kind":"navigated"} | {"kind":"no-failed-requests"} | ' +
  '{"kind":"no-console-errors"} | {"kind":"request-status","urlIncludes":"...","status":200}.';

function buildPrompt(intent: string, elements: PageElement[], steps: Step[]): string {
  const els = elements
    .slice(0, 60)
    .map((e) => `- [${e.role}] ${e.name}`)
    .join("\n");
  const history = steps.length
    ? steps.map((s, i) => `${i + 1}. ${JSON.stringify(s)}`).join("\n")
    : "(none yet)";
  return [
    `Intent: ${intent}`,
    ``,
    `Actions taken so far:`,
    history,
    ``,
    `Interactive elements now on the page:`,
    els || "(none)",
    ``,
    `What is the single next action? Respond with JSON only.`,
  ].join("\n");
}

/** Extract the first JSON object from a model reply, tolerating code fences/prose. */
export function parseDecision(text: string): Decision {
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`no JSON object in model reply: ${text.slice(0, 200)}`);
  }
  const obj = JSON.parse(s.slice(start, end + 1)) as Decision;
  if (!obj.action) throw new Error(`decision missing "action": ${s.slice(0, 200)}`);
  return obj;
}

const KNOWN_KINDS = new Set(["navigated", "no-failed-requests", "no-console-errors", "request-status"]);

/** Keep only assertions whose shape the deterministic critic understands. */
function sanitizeAssertions(input: Assertion[] | undefined): Assertion[] {
  const valid = (input ?? []).filter((a) => a && KNOWN_KINDS.has((a as { kind: string }).kind));
  return valid.length ? valid : [{ kind: "no-failed-requests" }];
}

export async function discover(intent: string, opts: DiscoverOptions): Promise<Scenario> {
  const { driver, llm, baseUrl, maxSteps = 8, onStep } = opts;
  const steps: Step[] = [];

  if (baseUrl) {
    await driver.goto(baseUrl);
    steps.push({ kind: "goto", url: baseUrl });
  }

  for (let i = 0; i < maxSteps; i++) {
    await driver.settle();
    const elements = await driver.snapshot();
    const reply = await llm.complete(buildPrompt(intent, elements, steps), { system: SYSTEM });
    const decision = parseDecision(reply);

    if (decision.action === "done") {
      onStep?.(decision);
      return { name: intent, steps, assertions: sanitizeAssertions(decision.assertions) };
    }

    let step: Step;
    switch (decision.action) {
      case "click":
        if (!decision.text) throw new Error('click decision missing "text"');
        await driver.click({ text: decision.text });
        step = { kind: "click", target: { text: decision.text } };
        break;
      case "type":
        if (!decision.text) throw new Error('type decision missing "text"');
        await driver.type({ text: decision.text }, decision.value ?? "");
        step = { kind: "type", target: { text: decision.text }, text: decision.value ?? "" };
        break;
      case "goto":
        if (!decision.url) throw new Error('goto decision missing "url"');
        await driver.goto(decision.url);
        step = { kind: "goto", url: decision.url };
        break;
      default:
        throw new Error(`unknown action: ${(decision as Decision).action}`);
    }
    steps.push(step);
    onStep?.(decision, step);
  }

  // Hit the safety cap without an explicit "done".
  return { name: intent, steps, assertions: [{ kind: "no-failed-requests" }] };
}
