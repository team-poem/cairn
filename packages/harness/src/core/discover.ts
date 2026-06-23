/**
 * The discover loop — the only place the agent loops (invariant #3). It observes the page,
 * asks the LLM for the next action, acts, and repeats until done, emitting a Scenario that
 * later replays with no LLM (invariant #4). LLM is behind the LlmClient seam (invariant #5).
 */
import type { Driver, LlmClient } from "./ports.js";
import type { Assertion, PageElement, Scenario, Step } from "./types.js";

export interface DiscoverOptions {
  driver: Driver;
  llm: LlmClient;
  baseUrl?: string;
  maxSteps?: number;
  onStep?: (decision: Decision, step?: Step) => void;
  /** Abort discovery between steps (a host's Stop button). */
  signal?: AbortSignal;
}

export interface Decision {
  action: "click" | "doubleClick" | "hover" | "type" | "select" | "pressKey" | "scroll" | "goto" | "done";
  text?: string;
  value?: string;
  key?: string;
  direction?: "down" | "up";
  url?: string;
  reason?: string;
  assertions?: Assertion[];
}

const SYSTEM =
  "You are a QA agent driving a web browser to satisfy a natural-language intent. " +
  "At each turn you see the page's interactive elements and the actions taken so far. " +
  "Respond with ONE next action as strict JSON, no prose, no code fences. " +
  "Actions: " +
  '{"action":"click","text":"<element>"} · {"action":"doubleClick","text":"<element>"} · ' +
  '{"action":"hover","text":"<element>"} (reveals flyout/dropdown menus) · ' +
  '{"action":"type","text":"<element>","value":"<text>"} · {"action":"select","text":"<element>","value":"<option>"} · ' +
  '{"action":"pressKey","key":"Enter|Escape|Tab|..."} · {"action":"scroll","direction":"down|up"} (load lazy content) · ' +
  '{"action":"goto","url":"<url>"} · {"action":"done"}. ' +
  'Always add "reason":"<short>". Use the exact element name shown. To open a menu before clicking a hidden item, hover it first. ' +
  'Use "done" when the intent is achieved (or impossible); with "done" you may include "assertions": an array of ' +
  '{"kind":"navigated"} | {"kind":"no-failed-requests"} | {"kind":"no-console-errors"} | {"kind":"request-status","urlIncludes":"...","status":200}.';

function buildPrompt(intent: string, elements: PageElement[], steps: Step[], failures: string[]): string {
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
    ...(failures.length
      ? [`These actions ALREADY FAILED — do NOT repeat them, choose a different element or approach:`, ...failures.map((f) => `- ${f}`), ``]
      : []),
    `Actions taken so far:`,
    history,
    ``,
    `Interactive elements now on the page:`,
    els || "(none)",
    ``,
    `What is the single next action? Respond with JSON only.`,
  ].join("\n");
}

/** First JSON object in a model reply, tolerating code fences and surrounding prose. */
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

/** Drop assertions the deterministic critic can't evaluate; fall back to a safe default. */
function sanitizeAssertions(input: Assertion[] | undefined): Assertion[] {
  const valid = (input ?? []).filter((a) => a && KNOWN_KINDS.has((a as { kind: string }).kind));
  return valid.length ? valid : [{ kind: "no-failed-requests" }];
}

/** Execute a non-`done` decision and return the Step it produced. Throws if it fails. */
async function applyDecision(driver: Driver, decision: Decision): Promise<Step> {
  const needText = (): string => {
    if (!decision.text) throw new Error(`${decision.action} decision missing "text"`);
    return decision.text;
  };
  switch (decision.action) {
    case "click":
      await driver.click({ text: needText() });
      return { kind: "click", target: { text: needText() } };
    case "doubleClick":
      await driver.doubleClick({ text: needText() });
      return { kind: "doubleClick", target: { text: needText() } };
    case "hover":
      await driver.hover({ text: needText() });
      return { kind: "hover", target: { text: needText() } };
    case "type":
      await driver.type({ text: needText() }, decision.value ?? "");
      return { kind: "type", target: { text: needText() }, text: decision.value ?? "" };
    case "select":
      await driver.select({ text: needText() }, decision.value ?? "");
      return { kind: "select", target: { text: needText() }, value: decision.value ?? "" };
    case "pressKey":
      if (!decision.key) throw new Error('pressKey decision missing "key"');
      await driver.pressKey(decision.key);
      return { kind: "pressKey", key: decision.key };
    case "scroll":
      await driver.scroll(decision.direction);
      return { kind: "scroll", direction: decision.direction };
    case "goto":
      if (!decision.url) throw new Error('goto decision missing "url"');
      await driver.goto(decision.url);
      return { kind: "goto", url: decision.url };
    default:
      throw new Error(`unknown action: ${decision.action}`);
  }
}

export async function discover(intent: string, opts: DiscoverOptions): Promise<Scenario> {
  const { driver, llm, baseUrl, maxSteps = 8, onStep, signal } = opts;
  const steps: Step[] = [];

  if (baseUrl) {
    await driver.goto(baseUrl);
    steps.push({ kind: "goto", url: baseUrl });
  }

  // Remember what already failed so the LLM stops retrying dead ends (real sites have
  // hover menus, overlays, maintenance pages). ADAPT is the point of the loop (invariant #3).
  const failures: string[] = [];
  for (let i = 0; i < maxSteps; i++) {
    signal?.throwIfAborted();
    await driver.settle();
    const elements = await driver.snapshot();
    const reply = await llm.complete(buildPrompt(intent, elements, steps, failures), { system: SYSTEM });
    const decision = parseDecision(reply);

    if (decision.action === "done") {
      onStep?.(decision);
      return { name: intent, steps, assertions: sanitizeAssertions(decision.assertions) };
    }

    try {
      const step = await applyDecision(driver, decision);
      steps.push(step);
      onStep?.(decision, step);
    } catch (err) {
      const what = `${decision.action}${decision.text ? ` "${decision.text}"` : decision.url ? ` ${decision.url}` : ""}`;
      failures.push(`${what} — ${err instanceof Error ? err.message : String(err)}`);
      onStep?.(decision);
    }
  }

  // Safety cap reached without an explicit "done".
  return { name: intent, steps, assertions: [{ kind: "no-failed-requests" }] };
}
