/** One decision's addressing table, separate from semantic page content and durable Targets. */
import type { Driver } from "./ports.js";
import type { PageElement, Target } from "./types.js";
import type { Decision } from "./discover/decision.js";
import { dupeOrdinals, renderElements, renderSelectionNotices, ELEMENT_LIMIT } from "./discover/prompt.js";
import { selectElements } from "./perception.js";
import { stepError } from "./errors.js";
import type { TargetCandidate } from "./target-choice.js";
import { candidateCounts, type SelectionDiagnostic, type SelectionSummary } from "./selection-diagnostics.js";
import type { TraceScope, TracePhase } from "./trace.js";
import { validateCollectionTarget } from "./collection.js";

let generation = 0;
const current = new WeakMap<Driver, PerceptionObservation>();
interface Binding { observation: PerceptionObservation; ref: string; token: string; action: Decision["action"]; value?: string; text: string; role: string; nth?: number; used: boolean }
const bindings = new WeakMap<Decision, Binding>();
const targeted = new Set(["click", "doubleClick", "hover", "type", "select"]);
function invalid(message: string): never { throw stepError("resolution", message); }
function sameName(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
}
// Optional model descriptions may shorten names; perception identity still requires sameName.
function describesName(text: unknown, name: string): boolean {
  if (typeof text !== "string") return false;
  const normalized = text.trim().toLowerCase();
  return sameName(text, name) || (normalized.length > 0 && name.toLowerCase().includes(normalized));
}

export class PerceptionObservation {
  readonly id: string;
  readonly omittedCount: number;
  readonly render: string;
  readonly references: string;
  private consumed = false;
  private decisionAttempt = 0;
  private readonly selection?: SelectionSummary;
  private readonly table = new Map<string, { element: PageElement; nth?: number }>();
  /** The rows of `render`, in order, with full-snapshot duplicate ordinals. */
  readonly listed: readonly { element: PageElement; nth?: number }[];

  constructor(private readonly driver: Driver, raw: PageElement[], perceived: PageElement[], intent: string, limit = ELEMENT_LIMIT, diagnostics = false) {
    current.set(driver, this);
    const id = ++generation;
    this.id = `o${id}`;
    const originals = new Map<string, PageElement>();
    for (const e of raw) if (e.ref !== undefined) {
      if (!e.ref || originals.has(e.ref)) invalid("duplicate or empty driver reference");
      originals.set(e.ref, e);
    }
    const rawOrdinals = dupeOrdinals(raw);
    const ordinals = dupeOrdinals(perceived);
    const retained = new Set<string>();
    for (const e of perceived) if (e.ref !== undefined) {
      const original = originals.get(e.ref);
      if (!original || retained.has(e.ref) || !sameName(original.name, e.name) || original.role !== e.role) {
        invalid("perception changed or duplicated an element binding");
      }
      retained.add(e.ref);
      ordinals.delete(e);
      const nth = rawOrdinals.get(original);
      if (nth !== undefined) ordinals.set(e, nth);
    }
    const { elements: ranked, omittedCount, diagnostics: selected } = selectElements(perceived, intent, limit, diagnostics);
    if (selected) this.selection = { raw: candidateCounts(raw), perceived: candidateCounts(perceived), ...selected };
    this.omittedCount = omittedCount;
    this.listed = ranked.map(element => ({ element, nth: ordinals.get(element) }));
    const body = renderElements(ranked, ordinals);
    const omitted = renderSelectionNotices(omittedCount, perceived.length - ranked.length - omittedCount);
    this.render = body + omitted;
    const lines: string[] = [];
    if (driver.locateRef) ranked.forEach((e, i) => {
      if (!e.ref) return;
      const token = `o${id}-${i}`;
      // Display normalization cannot replace the raw identity seen by policy and dispatch.
      this.table.set(token, { element: { ...e, name: originals.get(e.ref)!.name }, nth: ordinals.get(e) });
      lines.push(`- ref="${token}" ${renderElements([e], ordinals).slice(2)}`);
    });
    this.references = lines.length
      ? `Current observation references (valid for this decision only; use "ref" for exact selection):\n${lines.join("\n")}${omitted}`
      : "";
  }

  /** Call only after constructing an actual decision prompt, never for observation-only capture.
   * Admission happens inside the supplied model/budget wrappers AFTER this boundary. */
  tracePrepared(trace: TraceScope | undefined, purpose: SelectionDiagnostic["purpose"], phase: TracePhase): void {
    if (!trace || !this.selection) return;
    trace.emit({ kind: "selection", phase, payload: {
      ...this.selection, stage: "prepared", purpose, observationId: this.id,
      decisionId: `${this.id}:d${++this.decisionAttempt}`,
    } });
  }

  /** Structured selection over the SAME validated table as bind(); never parse rendered text. */
  candidates(): TargetCandidate[] {
    return [...this.table].map(([key, { element: e, nth }]) => ({ key, name: e.name, role: e.role,
      ...(nth !== undefined ? { nth } : {}), ...(e.checked !== undefined ? { checked: e.checked } : {}),
      ...(e.disabled !== undefined ? { disabled: e.disabled } : {}),
      ...(e.inActivePopup !== undefined ? { inActivePopup: e.inActivePopup } : {}),
      ...(e.clickable !== undefined ? { clickable: e.clickable } : {}) }));
  }

  /** Consume even rejected attempts. Canonicalize BEFORE ambiguity and consumer policy. */
  bind(decision: Decision): Decision {
    if (this.consumed) invalid("observation already consumed");
    if (current.get(this.driver) !== this) invalid("expired observation reference");
    this.consumed = true;
    if (decision.ref === undefined) return decision;
    if (!targeted.has(decision.action)) invalid("reference requires a target-bearing action");
    const row = this.table.get(decision.ref);
    if (!row) invalid("unknown or expired observation reference");
    const { element, nth } = row;
    const description = { text: element.name, role: element.role, ...(nth !== undefined ? { nth } : {}) };
    if ((decision.text !== undefined && !describesName(decision.text, element.name)) ||
        (decision.role !== undefined && decision.role !== element.role) ||
        (decision.nth !== undefined && decision.nth !== nth)) {
      invalid(`reference contradicts element description: selected ${JSON.stringify(description)}`);
    }
    const canonical = { ...decision, ...description };
    bindings.set(canonical, { observation: this, ref: element.ref!, token: decision.ref, action: decision.action, value: decision.value, text: element.name, role: element.role, nth, used: false });
    return canonical;
  }
}

/** Recheck observation ownership after any awaited enrichment or secret-origin observation.
 * A consumed decision may finish its own dispatch, but can never begin another execution. */
export function assertDecisionCurrent(driver: Driver, decision: Decision): void {
  const bound = bindings.get(decision);
  if (!bound && decision.ref === undefined) return;
  if (!bound || current.get(driver) !== bound.observation) invalid("unbound or expired observation reference");
  if (decision.ref !== bound.token || decision.action !== bound.action || decision.value !== bound.value ||
      decision.text !== bound.text || decision.role !== bound.role || decision.nth !== bound.nth) {
    invalid("bound decision description changed");
  }
}

/** Only a bound, current decision can obtain a driver token. Never resolve a raw model ref. */
export function decisionReference(driver: Driver, decision: Decision, consume = false): string | undefined {
  assertDecisionCurrent(driver, decision);
  const bound = bindings.get(decision);
  if (!bound) return undefined;
  if (bound.used) invalid("consumed observation reference");
  if (consume) bound.used = true;
  return bound.ref;
}

/** Explicit allowlist: runtime handles and extension fields cannot enter a frozen target. */
export function persistentTarget(target: Target): Target {
  if ("collection" in target) return { collection: validateCollectionTarget(target) };
  const out: Target = {};
  for (const key of ["text", "role", "selector"] as const) if (typeof target[key] === "string" && target[key]) out[key] = target[key];
  for (const key of ["index", "nth"] as const) if (typeof target[key] === "number" && Number.isInteger(target[key]) && target[key]! >= 0) out[key] = target[key];
  if (!out.text && !out.selector && !(out.role && out.index !== undefined)) invalid("exact node has no persistent target");
  return out;
}
