/**
 * LLM decisions and how they become executed Steps. A Decision is mapped to a typed Step
 * (`decisionToStep`, a pure translation plus locate-enrichment) and then executed through the SAME
 * `BuiltinStepHandler` the replay pipeline uses — one execution path for discover, replay, and
 * step-heal (invariant #2), instead of a second driver-dispatch switch drifting alongside it.
 */
import type { Driver } from "../ports.js";
import type { Assertion, PageElement, Step, Target, WaitUntil } from "../types.js";
import { BuiltinStepHandler } from "../steps.js";
import { extractFirstJsonObject } from "../json.js";

export interface Decision {
  action:
    | "click"
    | "doubleClick"
    | "hover"
    | "type"
    | "select"
    | "pressKey"
    | "scroll"
    | "goto"
    | "waitFor"
    /** Explore-only (#102): record an observed UX problem without touching the page. `text` carries
     * the problem, `severity` how bad it is. Discover's prompt never teaches it; if a model emits it
     * anyway, `decisionToStep` rejects it like `done`. */
    | "note"
    | "done";
  text?: string;
  /** Disambiguate identically-named elements (#127): the element's role, and the 0-based
   * position among same role+name matches — the `(nth=K)` marker the listing shows. */
  role?: string;
  nth?: number;
  value?: string;
  key?: string;
  direction?: "down" | "up";
  url?: string;
  until?: WaitUntil;
  reason?: string;
  assertions?: Assertion[];
  /** note: how bad the observed problem is (default "info"). */
  severity?: "info" | "warn" | "error";
}

export type PolicyVerdict = { ok: true } | { ok: false; reason: string };

/** What the loop can show a policy about the page (#77): the elements it just snapshotted, and —
 * when an observation is already in hand (vet) — the current URL. */
export interface PolicyContext {
  elements: readonly PageElement[];
  url?: string;
}

/**
 * A deterministic gate the discover loop consults before executing each proposed action (invariant #2:
 * inject behavior, don't branch in the loop). Kept app-agnostic (invariant #1) — the engine offers the
 * seam; a consumer supplies the rules (block destructive controls, cap wandering, stop on a goal).
 */
export interface ActionPolicy {
  /** Vet an action before it runs. Rejected → recorded as a failure so the LLM re-decides; it never
   * executes. A throwing vet is treated as a rejection, not a crash. A stateful policy may count
   * calls across the run (e.g. a consecutive-scroll cap). */
  vet(decision: Decision, ctx?: PolicyContext): PolicyVerdict;
  /** End discovery because the GOAL is reached — the freeze is trusted (non-truncated); step bounds
   * belong to `maxSteps`. Checked each iteration with the fresh page elements, and once more at the
   * step cap. `steps` includes the seed `baseUrl` goto. */
  stop?(steps: readonly Step[], ctx?: PolicyContext): boolean;
}

/** First JSON object in a model reply, tolerating fences, prose, and trailing extra objects. */
export function parseDecision(text: string): Decision {
  const obj = extractFirstJsonObject(text) as Decision | undefined;
  if (!obj) throw new Error(`no JSON object in model reply: ${text.slice(0, 200)}`);
  if (!obj.action) throw new Error(`decision missing "action": ${text.slice(0, 200)}`);
  // Models often quote a numeric field — coerce `"nth":"1"` so it addresses instead of
  // silently missing (the resolver would treat a string nth as absent). Non-numeric stays out.
  if (typeof obj.nth === "string" && /^\d+$/.test(obj.nth)) obj.nth = Number(obj.nth);
  return obj;
}

/**
 * Map a non-`done` decision to a typed Step. Target-bearing actions are enriched with resilient
 * locators (role + structural index) at freeze time, so replay survives a UI rename without the LLM.
 * Pure translation — execution happens through the shared step handler in `applyDecision`.
 */
export async function decisionToStep(driver: Driver, decision: Decision): Promise<Step> {
  const located = (): Promise<Target> => {
    if (!decision.text) throw new Error(`${decision.action} decision missing "text"`);
    return driver.locate({
      text: decision.text,
      ...(decision.role !== undefined ? { role: decision.role } : {}),
      ...(decision.nth !== undefined ? { nth: decision.nth } : {}),
    });
  };
  switch (decision.action) {
    case "click":
      return { kind: "click", target: await located() };
    case "doubleClick":
      return { kind: "doubleClick", target: await located() };
    case "hover":
      return { kind: "hover", target: await located() };
    case "type":
      return { kind: "type", target: await located(), text: decision.value ?? "" };
    case "select":
      return { kind: "select", target: await located(), value: decision.value ?? "" };
    case "pressKey":
      if (!decision.key) throw new Error('pressKey decision missing "key"');
      return { kind: "pressKey", key: decision.key };
    case "scroll":
      return { kind: "scroll", direction: decision.direction };
    case "goto":
      if (!decision.url) throw new Error('goto decision missing "url"');
      return { kind: "goto", url: decision.url };
    case "waitFor":
      if (!decision.until) throw new Error('waitFor decision missing "until"');
      return { kind: "waitFor", until: decision.until };
    case "note":
      throw new Error('"note" is not an executable action');
    case "done":
      throw new Error('"done" is not an executable action');
    default: {
      // Exhaustiveness guard: a new action the mapping doesn't handle fails to compile here.
      const unhandled: never = decision.action;
      throw new Error(`unknown action: ${String(unhandled)}`);
    }
  }
}

const execute = new BuiltinStepHandler();

/** Execute a non-`done` decision and return the Step it produced. Throws if it fails. */
export async function applyDecision(driver: Driver, decision: Decision): Promise<Step> {
  const step = await decisionToStep(driver, decision);
  await execute.execute(step, driver);
  return step;
}

/** A short `action "text"|url` label for failure/policy messages. */
export function describeAction(decision: Decision): string {
  const detail = decision.text ? ` "${decision.text}"` : decision.url ? ` ${decision.url}` : "";
  return `${decision.action}${detail}`;
}

/**
 * Why a target-bearing decision is ambiguous on this page, or undefined if it isn't (#127): the
 * name matches several elements within one role and the decision carries no `nth`. Checked by the
 * loop BEFORE the driver runs — the principle lives once in core, so every consumer's driver gets
 * it — and the message tells the model how to re-decide. Cross-role multi-matches are not
 * ambiguous here: an a11y wrapper pair (link over its own StaticText) is the common benign case,
 * and a real cross-role duplicate is addressable by sending `role`.
 */
export function describeAmbiguity(
  decision: Decision,
  elements: readonly PageElement[],
): string | undefined {
  if (!decision.text || decision.nth !== undefined) return undefined;
  const needle = decision.text.trim().toLowerCase();
  const matches = elements.filter(
    (e) => (!decision.role || e.role === decision.role) && e.name.trim().toLowerCase() === needle,
  );
  if (matches.length < 2) return undefined;
  const byRole = new Map<string, number>();
  for (const m of matches) byRole.set(m.role, (byRole.get(m.role) ?? 0) + 1);
  const dupedRoles = [...byRole.entries()].filter(([, n]) => n > 1).map(([r]) => r);
  if (!dupedRoles.length) return undefined;
  return `${matches.length} elements named "${decision.text}" (${dupedRoles.join("/")}) — add "role" (and the 0-based "nth" shown in the listing if that role still repeats)`;
}
