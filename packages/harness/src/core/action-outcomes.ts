import type { Decision } from "./discover/decision.js";
import type { Driver } from "./ports.js";
import type { PageElement, Step } from "./types.js";

export type ActionOutcomeStatus = "observed-change" | "no-observed-change" | "insufficient-evidence";
export interface ActionOutcomeOptions {
  /** Consecutive comparable unchanged clicks on one node before recovery. During recovery
   * the same limit applies per node across the remaining decisions. Default 2, range 1..32. */
  maxRepeats?: number;
  /** Further decision calls allowed to find a different action. Default 2, range 1..16. */
  recoveryTurns?: number;
  /** Select all relevant rows from this observation, or return undefined if coverage is unknown.
   * Return original rows, not copies. No raw driver refs are provided. */
  scope?: (elements: readonly PageElement[]) => readonly PageElement[] | undefined;
  /** One settled observation after an acknowledged step. Contains no target, values or driver IDs. */
  onOutcome?: (outcome: { action: Step["kind"]; stepIndex: number; status: ActionOutcomeStatus }) => void;
}

// Compare bounded snapshots, never rotating refs. Refs only join a host correction to
// a raw row within the same capture; neither the refs nor the input objects are retained.
const MAX_ROWS = 512, MAX_CHARS = 32768;
const fields = ["value", "checked", "disabled", "inActivePopup", "occluded", "clickable", "pressed", "expanded", "selected"] as const;
type Row = { raw: PageElement; corrected?: PageElement };
interface Frame {
  rows?: readonly Row[];
  targets?: ReadonlyMap<string, Row | undefined>;
  unmatchedCorrection?: boolean;
  url?: string;
  requests?: number;
}
const targetKey = (role?: string, name?: string) => name && (role?.length ?? 0) + name.length <= MAX_CHARS
  ? JSON.stringify([role ?? null, name]) : "";
const boundedUrl = (url?: string) => url && url.length <= 4096 ? url : undefined;
const requestWatermark = (n: number | undefined) => n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
function copyRow(e: PageElement): PageElement {
  return { role: e.role, name: e.name, value: e.value, checked: e.checked, disabled: e.disabled,
    inActivePopup: e.inActivePopup, occluded: e.occluded, clickable: e.clickable,
    pressed: e.pressed, selected: e.selected, expanded: e.expanded };
}
function putUnique<T>(map: Map<string, T | undefined>, key: string, value: T) {
  if (key) map.set(key, map.has(key) ? undefined : value);
}
const limit = (n: number | undefined, fallback: number, max: number) => {
  if (n === undefined) return fallback;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new RangeError(`Action outcome limit must be an integer from 1 to ${max}`);
  return n;
};

const changed = "observed-change", same = "no-observed-change", unknown = "insufficient-evidence";
function facts(a: PageElement, b: PageElement): ActionOutcomeStatus {
  if (a.name !== b.name || a.role !== b.role) return changed;
  let result: ActionOutcomeStatus = same;
  for (const field of fields) {
    if (a[field] === b[field]) continue;
    // A missed probe is not a state transition. Other measured fields can still change.
    if (a[field] !== undefined && b[field] !== undefined) return changed;
    result = unknown;
  }
  return result;
}
function rowDelta(a: Row, b: Row): ActionOutcomeStatus {
  const raw = facts(a.raw, b.raw);
  if (raw === changed) return changed;
  const host = a.corrected && b.corrected ? facts(a.corrected, b.corrected)
    : a.corrected === b.corrected ? same : unknown;
  return host === changed ? changed : raw === unknown || host === unknown ? unknown : same;
}
/** A named checkbox is not a measurement of its check state. These roles identify
 * which fact the control itself must expose; an ordinary button need not be a toggle. */
function hasControlState(row: Row): boolean {
  switch (row.raw.role) {
    case "checkbox": case "switch": case "radio": case "menuitemcheckbox": case "menuitemradio":
      return row.raw.checked !== undefined || row.corrected?.checked !== undefined;
    case "option": case "tab":
      return row.raw.selected !== undefined || row.corrected?.selected !== undefined;
    default: return true;
  }
}
function rowComparison(a: Frame, b: Frame, key?: string): ActionOutcomeStatus {
  if (!a.rows || !b.rows) return unknown;
  if (a.rows.length !== b.rows.length) return changed;
  let result: ActionOutcomeStatus = a.unmatchedCorrection || b.unmatchedCorrection ? unknown : same;
  for (let i = 0; i < a.rows.length; i++) {
    const delta = rowDelta(a.rows[i]!, b.rows[i]!);
    if (delta === changed) return changed;
    if (delta === unknown) result = unknown;
  }
  if (key !== undefined) {
    // Scope evidence stands even if the acted target disappeared. Equality, however,
    // requires the target's own state in both observations, scoped or not.
    const left = a.targets?.get(key), right = b.targets?.get(key);
    if (!left || !right) return unknown;
    const target = rowDelta(left, right);
    if (target !== same) return target;
    if (!hasControlState(left) || !hasControlState(right)) return unknown;
  }
  return result;
}
function compare(a: Frame, b: Frame, key?: string): ActionOutcomeStatus {
  if (a.url !== undefined && b.url !== undefined && a.url !== b.url ||
      a.requests !== undefined && b.requests !== undefined && b.requests > a.requests) return changed;
  const rows = rowComparison(a, b, key);
  if (rows !== same) return rows;
  return a.url && b.url && a.requests !== undefined && b.requests === a.requests ? same : unknown;
}
const safeId = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 256;
class RepeatBlocked extends Error {}

/** Feedback is descriptive. Only the opt-in policy, comparing acknowledged clicks with an
 * adapter-confirmed identity, can refuse a new dispatch. Nothing rewrites the executed path. */
export class ActionOutcomeTracker {
  private readonly repeats: number;
  private readonly recovery: number;
  private readonly options?: Readonly<ActionOutcomeOptions>;
  private pending?: { action: Step["kind"]; stepIndex: number; frame: Frame; id?: string; key?: string };
  private previous?: { id: string; frame: Frame; count: number };
  // During recovery, at most one new entry per admitted decision (maximum 16).
  private readonly blockedTargets = new Map<string, { frame: Frame; key?: string }>();
  private readonly recoveryCounts = new Map<string, { frame: Frame; count: number }>();
  private turns = 0;
  private message?: string;
  private armed = false;
  private instrumented = false;
  private attempted?: "click-dispatch-uncertain" | "action-dispatch-uncertain";
  private click = false;
  private checkClick?: () => void;
  private proposedId?: string;
  constructor(options?: ActionOutcomeOptions) {
    this.options = options && { ...options };
    this.repeats = limit(options?.maxRepeats, 2, 32);
    this.recovery = limit(options?.recoveryTurns, 2, 16);
  }
  get suspect() { return this.blockedTargets.size !== 0; }
  get halt() { return this.suspect && this.turns >= this.recovery; }
  get hasPending() { return this.pending !== undefined; }
  get dispatchUncertain() { return this.attempted; }
  get feedback() {
    return this.suspect
      ? [this.message, "A target reached the limit for clicks with no observed change. Choose a different action on the current page; completion has not been verified."].filter(Boolean).join(" ")
      : this.message;
  }
  admitDecision() { if (this.suspect) this.turns++; }

  capture(elements: readonly PageElement[], url: string | undefined, requestCount: number | undefined,
    perceived?: readonly PageElement[]): Frame {
    const frame: Frame = { url: boundedUrl(url), requests: requestWatermark(requestCount) };
    if (!elements.length || elements.length > MAX_ROWS || (perceived?.length ?? 0) > MAX_ROWS) return frame;
    let chars = 1; // One array of all compared raw and corrected rows, including separators.
    const fits = (e: PageElement) => {
      if (e.role.length + e.name.length + (e.value?.length ?? 0) > MAX_CHARS - chars) return false;
      chars += JSON.stringify(e).length + 1;
      return chars <= MAX_CHARS;
    };
    const rows: Row[] = [];
    const byTarget = new Map<string, Row | undefined>(), byRef = new Map<string, Row | undefined>();
    for (const e of elements) {
      const row: Row = { raw: copyRow(e) };
      if (!fits(row.raw)) return frame;
      rows.push(row);
      putUnique(byTarget, targetKey(e.role, e.name), row);
      putUnique(byTarget, targetKey(undefined, e.name), row);
      if (perceived && e.ref) putUnique(byRef, e.ref, row);
    }
    let unmatched = false;
    if (perceived) {
      const matched = new Set<Row>();
      for (const e of perceived) {
        const correction = copyRow(e);
        if (!fits(correction)) return frame;
        const row = e.ref ? byRef.get(e.ref) : byTarget.get(targetKey(e.role, e.name));
        if (!row || row.raw.role !== e.role || row.raw.name.trim().toLowerCase() !== e.name.trim().toLowerCase()) {
          unmatched = true;
          continue;
        }
        if (matched.has(row)) { unmatched = true; row.corrected = undefined; continue; }
        matched.add(row);
        // Host display normalization isn't a state transition; keep the raw name for binding.
        row.corrected = { ...correction, name: row.raw.name };
      }
      if (!matched.size) unmatched = true;
    }
    let selected = rows;
    if (this.options?.scope) {
      // Treat the selector as a declaration of coverage, not as an evidence generator.
      const offered = new Set(rows.map(row => row.raw));
      let subset: readonly PageElement[] | undefined;
      try { subset = this.options.scope(Object.freeze(rows.map(row => Object.freeze(row.raw)))); }
      catch { return frame; } // An unavailable host measurement is not an action failure.
      if (!Array.isArray(subset) || !subset.length || subset.length > rows.length) return frame;
      for (let i = 0; i < subset.length; i++) if (!offered.delete(subset[i]!)) return frame;
      // Selection defines membership. Only the observed page can establish a change in order.
      selected = rows.filter(row => !offered.has(row.raw));
    }
    return { ...frame, rows: selected, targets: byTarget, unmatchedCorrection: unmatched };
  }

  atDispatch(frame: Frame, url: string | undefined, requests: number): Frame {
    // A newer network watermark or different/unknown URL means the listing is not a
    // reliable pre-input measurement. Keep the independent URL and request evidence.
    const watermark = { url: boundedUrl(url), requests: requestWatermark(requests) };
    if (this.options && (!frame.url || frame.url !== watermark.url ||
        frame.requests === undefined || frame.requests !== watermark.requests)) return watermark;
    return { ...frame, ...watermark };
  }

  arm(driver: Driver, decision: Decision, check: () => void) {
    this.attempted = undefined;
    this.click = decision.action === "click";
    this.armed = !!this.options && decision.action !== "waitFor";
    this.checkClick = this.armed ? check : undefined;
    this.proposedId = undefined;
    this.instrumented = this.armed && this.click && !!driver.armActionOutcomeIdentity && !!driver.takeActionOutcomeIdentity;
    if (this.instrumented) driver.armActionOutcomeIdentity!(id => {
      check();
      if (safeId(id) && this.blockedTargets.has(id)) throw new RepeatBlocked("repeated click without observed progress");
      this.proposedId = safeId(id) ? id : undefined;
      this.attempted = "click-dispatch-uncertain";
    }, check);
  }
  /** A legacy Driver cannot distinguish failed dispatch from an unacknowledged click. */
  beforeDriverInput = () => {
    this.checkClick?.();
    if (this.armed && !this.instrumented)
      this.attempted = this.click ? "click-dispatch-uncertain" : "action-dispatch-uncertain";
  };
  take(driver: Driver, _decision: Decision): string | undefined {
    const armed = this.instrumented;
    this.armed = this.instrumented = false;
    this.checkClick = undefined;
    try {
      const id = armed ? driver.takeActionOutcomeIdentity?.() : undefined;
      return safeId(id) && id === this.proposedId ? id : undefined;
    } catch {
      // Losing optional identity neither erases an acknowledged action nor masks its error.
      return undefined;
    }
  }
  blocked(error: unknown) { return error instanceof RepeatBlocked; }
  executed(step: Step, frame: Frame, id: string | undefined, stepIndex: number) {
    this.attempted = undefined;
    const key = "target" in step ? targetKey(step.target.role, step.target.text) : undefined;
    this.pending = { action: step.kind, stepIndex, frame,
      id: step.kind === "click" && safeId(id) ? id : undefined, key };
    this.message = undefined;
  }
  observe(frame: Frame): ActionOutcomeStatus | undefined {
    const pending = this.pending;
    this.pending = undefined;
    const delayed = [...this.blockedTargets.values()].some(blocked => pending
      // A request or navigation BEFORE another input is not an effect of that input.
      // The original target's semantic state is still relevant on the same known page.
      ? !!frame.url && blocked.frame.url === frame.url && rowComparison(blocked.frame, frame, blocked.key) === changed
      : compare(blocked.frame, frame, blocked.key) === changed);
    if (!pending) {
      // A delayed effect can appear while a proposed action is being vetoed. It changes
      // what we know about this page, not the historical outcome of another action.
      if (delayed) {
        this.clearRepeats();
        this.message = "A later observation changed; reassess the current page.";
      }
      return;
    }
    // If the pre-input watermark was already newer, a later veto/parse retry must
    // not rediscover that old traffic as a delayed effect of a blocked target.
    for (const blocked of this.blockedTargets.values()) {
      if (blocked.frame.url !== pending.frame.url) {
        blocked.frame = { url: pending.frame.url, requests: pending.frame.requests };
      } else if (blocked.frame.requests !== pending.frame.requests) {
        blocked.frame = { ...blocked.frame, requests: pending.frame.requests };
      }
    }
    const status = compare(pending.frame, frame, pending.key);
    const description = { "observed-change": "a change was observed; this does not verify the goal",
      "no-observed-change": "no change was observed in the available evidence",
      "insufficient-evidence": "insufficient evidence to compare the observations" }[status];
    // Unguided discovery doesn't normally read the URL/network at turn entry. Still tell
    // the model what it can see without adding a default Driver call or inferring no effect.
    const limited = status === unknown && rowComparison(pending.frame, frame, pending.key) === same
      ? "no change was observed in the compared page elements; other evidence is insufficient" : description;
    this.message = `After the last executed ${pending.action}: ${limited}.`;
    if (status === changed || delayed) {
      this.clearRepeats();
      if (delayed && status !== changed) this.message += " An earlier target or its comparison scope changed.";
    } else if (status === same && pending.id) {
      const previous = this.suspect ? this.recoveryCounts.get(pending.id) :
        this.previous?.id === pending.id ? this.previous : undefined;
      const count = previous && compare(previous.frame, pending.frame, pending.key) === same
        ? previous.count + 1 : 1;
      this.previous = { id: pending.id, frame, count };
      if (count >= this.repeats) this.blockedTargets.set(pending.id, { frame, key: pending.key });
      if (this.suspect) this.recoveryCounts.set(pending.id, this.previous);
    } else {
      this.previous = undefined;
      if (pending.id) this.recoveryCounts.delete(pending.id);
    }
    this.options?.onOutcome?.({ action: pending.action, stepIndex: pending.stepIndex, status });
    return status;
  }
  private clearRepeats() {
    this.previous = undefined;
    this.blockedTargets.clear();
    this.recoveryCounts.clear();
    this.turns = 0;
  }
}
