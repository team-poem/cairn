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
  /**
   * Allow the freeze to carry LLM-judged `expect` assertions (semantic checks). Off by default:
   * `expect` needs an LlmCritic at replay, so the deterministic critic fails it (invariant #4).
   * When off, only evidence-grounded mechanical assertions are frozen — replay stays LLM-free.
   */
  semanticChecks?: boolean;
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

const ELEMENT_LIMIT = 60;
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "checkbox", "radio", "combobox", "menuitem", "menuitemcheckbox",
  "menuitemradio", "tab", "switch", "option", "searchbox", "slider", "spinbutton",
]);

/**
 * #15 — rank the snapshot before the cutoff so it keeps what matters on a heavy page: interactive
 * controls first, then intent-relevant names. A flat `slice(0, N)` can drop the one control a flow
 * needs when a page has thousands of elements (seen in dogfooding) — ranking is correctness, not just cost.
 */
export function rankElements(elements: PageElement[], intent: string, limit: number): PageElement[] {
  const words = intent.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
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

function renderElements(elements: PageElement[]): string {
  return elements.map((e) => `- [${e.role}] ${e.name}`).join("\n");
}

function buildPrompt(
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
  const elementsBlock = render && render === prevRender ? "(unchanged from previous step)" : render || "(none)";
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
    elementsBlock,
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
 * keep a proposed `request-status` ONLY if a captured request actually matches it (so a
 * hallucinated check can't fail every replay). `expect` (LLM-judged) is frozen only when
 * `semantic` is set — otherwise the freeze stays deterministic (invariant #4).
 */
function deriveAssertions(
  proposed: Assertion[] | undefined,
  evidence: Evidence,
  semantic: boolean,
): Assertion[] {
  const out: Assertion[] = [{ kind: "no-failed-requests" }];
  const { navigated, finalUrl } = evidence.execution;
  // assert reaching the RIGHT destination (host+path), not just "navigated" — catches a flow
  // that lands on an error/wrong page yet technically navigated.
  if (navigated && finalUrl) out.push({ kind: "navigated", to: destinationKey(finalUrl) });
  else if (navigated) out.push({ kind: "navigated" });
  for (const a of proposed ?? []) {
    if (!a || typeof (a as { kind?: unknown }).kind !== "string") continue;
    if (a.kind === "request-status") {
      // grounding: keep only if a real captured request matches this URL + status.
      const matches = evidence.logic.requests.some(
        (r) => r.url.includes(a.urlIncludes) && r.status === a.status,
      );
      if (matches) out.push({ kind: "request-status", urlIncludes: a.urlIncludes, status: a.status });
    } else if (a.kind === "expect" && semantic && typeof a.criterion === "string" && a.criterion.trim()) {
      out.push({ kind: "expect", criterion: a.criterion.trim() });
    }
  }
  return dedupeAssertions(out);
}

/** Drop duplicate assertions (e.g. a proposed request-status the LLM listed twice). */
function dedupeAssertions(assertions: Assertion[]): Assertion[] {
  const seen = new Set<string>();
  return assertions.filter((a) => {
    const key = JSON.stringify(a);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const ASSERT_SYSTEM =
  "You propose verification assertions for a QA scenario, grounded ONLY in the observed evidence — " +
  "never invent a request or page that is not shown. Given the intent and what the run observed, " +
  "return a JSON array of assertions confirming the intent was achieved. Prefer concrete deterministic " +
  'checks: {"kind":"request-status","urlIncludes":"<url-substring>","status":200} for the key API call(s) ' +
  'that prove success, and {"kind":"navigated","to":"<host+path>"} for the destination. ' +
  "Return [] if the defaults already suffice. JSON array only, no prose, no code fences.";

const ASSERT_SYSTEM_SEMANTIC =
  ' You may also add {"kind":"expect","criterion":"<natural-language success criterion>"} ' +
  "for a check no mechanical assertion captures (judged later by an LLM critic).";

/** Compact evidence rendering for the assertion-proposal prompt. */
function renderEvidence(evidence: Evidence): string {
  const { execution, logic } = evidence;
  const requests = logic.requests
    .slice(0, 40)
    .map((r) => `${r.status} ${r.method} ${r.url}`)
    .join("\n");
  const errors = logic.console.filter((m) => m.type === "error").map((m) => m.text);
  return [
    `finalUrl: ${execution.finalUrl ?? "(none)"} (navigated: ${execution.navigated})`,
    `requests (${logic.requests.length}):`,
    requests || "(none)",
    `console errors (${errors.length}): ${errors.slice(0, 5).join(" | ") || "(none)"}`,
  ].join("\n");
}

/**
 * #16 — at the end of discover, ask the LLM to propose intent-grounded assertions so the freeze
 * carries meaningful checks beyond the default network guard ("passed but wrong"). The proposal is
 * grounded by `deriveAssertions`, so a hallucinated check is dropped and replay stays deterministic.
 */
async function proposeAssertions(
  llm: LlmClient,
  intent: string,
  evidence: Evidence,
  semantic: boolean,
): Promise<Assertion[]> {
  const system = semantic ? ASSERT_SYSTEM + ASSERT_SYSTEM_SEMANTIC : ASSERT_SYSTEM;
  const prompt = [
    `Intent: ${intent}`,
    ``,
    `Observed evidence:`,
    renderEvidence(evidence),
    ``,
    `Propose the verification assertions. JSON array only.`,
  ].join("\n");
  try {
    const reply = await llm.complete(prompt, { system });
    return extractJsonArray(reply);
  } catch {
    return [];
  }
}

/** First balanced [...] array in a model reply, tolerant of fences/prose; [] on failure. */
function extractJsonArray(text: string): Assertion[] {
  const s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = s.indexOf("[");
  if (start === -1) return [];
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
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) {
      try {
        const arr = JSON.parse(s.slice(start, i + 1));
        return Array.isArray(arr) ? (arr as Assertion[]) : [];
      } catch {
        return [];
      }
    }
  }
  return [];
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
  const { driver, llm, baseUrl, maxSteps = 8, onStep, signal, semanticChecks = false } = opts;
  const steps: Step[] = [];

  if (baseUrl) {
    await driver.goto(baseUrl);
    steps.push({ kind: "goto", url: baseUrl });
  }

  // Remember what already failed so the LLM stops retrying dead ends (real sites have
  // hover menus, overlays, maintenance pages). ADAPT is the point of the loop (invariant #3).
  const failures: string[] = [];
  let prevRender = "";
  for (let i = 0; i < maxSteps; i++) {
    signal?.throwIfAborted();
    await driver.settle();
    const elements = await driver.snapshot();
    const render = renderElements(rankElements(elements, intent, ELEMENT_LIMIT));
    const reply = await llm.complete(buildPrompt(intent, render, prevRender, steps, failures), {
      system: SYSTEM,
    });
    prevRender = render;

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
      const proposed = [
        ...(decision.assertions ?? []),
        ...(await proposeAssertions(llm, intent, evidence, semanticChecks)),
      ];
      return { name: intent, steps, assertions: deriveAssertions(proposed, evidence, semanticChecks) };
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

  // Safety cap reached without an explicit "done" — still ground assertions in what happened.
  const evidence = await driver.observe();
  const proposed = await proposeAssertions(llm, intent, evidence, semanticChecks);
  return { name: intent, steps, assertions: deriveAssertions(proposed, evidence, semanticChecks) };
}
