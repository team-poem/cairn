/**
 * The discover loop — the only place the agent loops (invariant #3). It observes the page,
 * asks the LLM for the next action, acts, and repeats until done, emitting a Scenario that
 * later replays with no LLM (invariant #4). LLM is behind the LlmClient seam (invariant #5).
 */
import type { Driver, LlmClient } from "./ports.js";
import type { Assertion, Evidence, PageElement, Scenario, Step, Target } from "./types.js";

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

/** First JSON object in a model reply, tolerating fences, prose, and trailing extra objects. */
export function parseDecision(text: string): Decision {
  const obj = extractFirstJsonObject(text) as Decision | undefined;
  if (!obj) throw new Error(`no JSON object in model reply: ${text.slice(0, 200)}`);
  if (!obj.action) throw new Error(`decision missing "action": ${text.slice(0, 200)}`);
  return obj;
}

/**
 * Extract the FIRST complete balanced {...} object. Slicing first-`{` to last-`}` breaks
 * when a model emits two objects or trailing text (a real crash seen on complex flows);
 * this scans braces (string-aware) and stops at the first balanced close.
 */
function extractFirstJsonObject(text: string): unknown {
  const s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = s.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Ground the frozen scenario's assertions in what actually happened, not what the LLM
 * guessed — it would propose `navigated` even on a SPA that never navigates, making every
 * replay fail. Always check requests; add `navigated` only if the run truly navigated;
 * keep any LLM-proposed `request-status` (still deterministic).
 */
function deriveAssertions(proposed: Assertion[] | undefined, evidence: Evidence): Assertion[] {
  const out: Assertion[] = [{ kind: "no-failed-requests" }];
  const { navigated, finalUrl } = evidence.execution;
  // assert reaching the RIGHT destination (host+path), not just "navigated" — catches a flow
  // that lands on an error/wrong page yet technically navigated.
  if (navigated && finalUrl) out.push({ kind: "navigated", to: destinationKey(finalUrl) });
  else if (navigated) out.push({ kind: "navigated" });
  for (const a of proposed ?? []) {
    if (a && (a as { kind: string }).kind === "request-status") out.push(a);
  }
  return out;
}

/** host + path of a url (query/hash dropped) — a stable, meaningful destination to assert. */
function destinationKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** Execute a non-`done` decision and return the Step it produced. Throws if it fails. */
async function applyDecision(driver: Driver, decision: Decision): Promise<Step> {
  // Enrich the target with resilient locators (role + structural index) before acting, and
  // freeze the enriched target — so replay survives a UI rename without the LLM.
  const located = (): Promise<Target> => {
    if (!decision.text) throw new Error(`${decision.action} decision missing "text"`);
    return driver.locate({ text: decision.text });
  };
  switch (decision.action) {
    case "click": {
      const target = await located();
      await driver.click(target);
      return { kind: "click", target };
    }
    case "doubleClick": {
      const target = await located();
      await driver.doubleClick(target);
      return { kind: "doubleClick", target };
    }
    case "hover": {
      const target = await located();
      await driver.hover(target);
      return { kind: "hover", target };
    }
    case "type": {
      const target = await located();
      await driver.type(target, decision.value ?? "");
      return { kind: "type", target, text: decision.value ?? "" };
    }
    case "select": {
      const target = await located();
      await driver.select(target, decision.value ?? "");
      return { kind: "select", target, value: decision.value ?? "" };
    }
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

    let decision: Decision;
    try {
      decision = parseDecision(reply);
    } catch {
      // A malformed reply must not kill the whole discovery — nudge and retry.
      failures.push("your previous reply was not a single valid JSON action object");
      continue;
    }

    if (decision.action === "done") {
      onStep?.(decision);
      const evidence = await driver.observe();
      return { name: intent, steps, assertions: deriveAssertions(decision.assertions, evidence) };
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
