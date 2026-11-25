import { compareContracts, hashContractValue, isContractIdentity, scenarioContract, type IdentifyScenarioOptions } from "./contract.js";
import type { StepHandler, StepHealer } from "./ports.js";
import type { Scenario, Step, Target } from "./types.js";

/** Trusted application contract, not an inference from the discovery observations. The host
 * guarantees that repeating this exact click in this scope has no required effect, including
 * requests, intermediate evidence, or work observed by a custom check. Change the revision if
 * the UI, environment or any such dependency changes; supply the current declaration at replay. */
export interface ReplayCleanupDeclaration {
  revision: string;
  scope: string;
  semantics: "idempotent-click";
  target: Target;
  /** Original zero-based occurrence of the repeat, not the index of its first matching target. */
  repeatIndex: number;
}

export type DiscoveryRefusal = "incomplete-discovery" | "protected-discovery" | "incomplete-recording"
  | "unsupported-path" | "unconfirmed-click-pair" | "repeat-not-idle" | "unsettled-effects";
type DeclineReason = DiscoveryRefusal | "unsupported-data" | "unsupported-path" | "missing-declaration"
  | "invalid-declaration" | "recording-mismatch" | "protected-occurrence" | "unsupported-replay" | "stale-approval" | "unidentified-judgment";
export type ReplayCleanupRecording =
  | { version: 1; status: "unavailable"; reason: DiscoveryRefusal | "unsupported-data" | "unsupported-path" }
  | { version: 1; status: "recorded"; historyFingerprint: string; assertionCount: number; discoveryJudgment: string | null };

export interface ReplayCleanupApproval {
  version: 1;
  status: "approved";
  reason: "declared-terminal-repeat";
  sourceFingerprint: string;
  planFingerprint: string;
  declarationFingerprint: string;
  /** All steps 0..keptThrough retain their original indices; only removedIndex is omitted. */
  mapping: { keptThrough: number; removedIndex: number };
}
export type ReplayCleanupDecision = ReplayCleanupApproval | { status: "declined"; reason: DeclineReason };
export interface ReplayCleanupOptions {
  approval: ReplayCleanupApproval;
  declaration: ReplayCleanupDeclaration;
  /** Synchronous diagnostic notification; receives no action, target or captured observation. */
  onDecision?: (decision: ReplayCleanupDecision) => void;
}
export interface ReplayCleanupProtection {
  /** Maximum original prefix length already claimed by an engine-owned evidence session. */
  protectedPrefixLength?: number;
  /** The actual replay judge configuration and Context intent (always supplied by the pipeline). */
  judgment?: IdentifyScenarioOptions;
  differentStepMatchRules?: boolean;
  stepHandlers?: readonly StepHandler[];
  stepHealer?: StepHealer;
  signal?: AbortSignal;
  screenshots?: boolean;
}

const maxSteps = 1_000, maxAssertions = 256;
const declined = (reason: DeclineReason): ReplayCleanupDecision => ({ status: "declined", reason });
const unavailable = (reason: Extract<ReplayCleanupRecording, {status: "unavailable"}>["reason"]): ReplayCleanupRecording =>
  ({ version: 1, status: "unavailable", reason });
const refusals = new Set(["incomplete-discovery", "protected-discovery", "incomplete-recording", "unsupported-data",
  "unsupported-path", "unconfirmed-click-pair", "repeat-not-idle", "unsettled-effects"]);
const boundedText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && value.trim().length > 0;
const fingerprint = (purpose: string, value: unknown) => hashContractValue(["replay-cleanup", 1, purpose, value]);

// In-memory discovery can spell an omitted optional field as undefined. Normalize only known
// schema positions. An opaque custom param containing undefined is NOT the same as an absent key.
function optionalField(path: readonly string[], key: string): boolean {
  if (!path.length) return ["contract", "provenance", "truncated", "truncationReason", "wildcards", "unprovenAction", "unattributedCriteria"].includes(key);
  const last = path.at(-1);
  if (path.length === 1) return (last === "contract" && key === "intentHash") || (last === "provenance" && key === "appContextHash");
  if (path.length === 2 && path[0] === "steps") return ["intent", "expect", "direction", "timeoutMs", "params"].includes(key);
  if (path.length === 2 && path[0] === "assertions")
    return ["origin", "vacuous", "vacuousBecause", "to", "observedBeforeLastMutation", "method", "criterionIds", "params"].includes(key);
  if (path.length === 3 && path[0] === "steps" && last === "target")
    return ["text", "role", "index", "nth", "selector", "collection"].includes(key);
  if (path.length === 3 && path[0] === "steps" && (last === "expect" || last === "until"))
    return ["role", "text", "url", "requestStatus"].includes(key);
  return path.length === 4 && path[0] === "steps" && ["expect", "until"].includes(path[2]!)
    && last === "requestStatus" && key === "method";
}

/** Snapshot before the first await, without running a getter/toJSON or coercing unsupported data.
 * Limits bound both fingerprint work and the size of an optional cleanup decision's inputs. */
function snapshot<T>(input: T, kind?: "scenario" | "declaration" | "judgment", originals?: WeakMap<object, object>,
  size = { nodes: 0, chars: 0 }): T {
  const active = new Set<object>();
  const invalid = (): never => { throw new Error("unsupported replay cleanup data"); };
  const copy = (v: unknown, path: string[]): unknown => {
    if (++size.nodes > 65_536 || path.length > 64) return invalid();
    if (typeof v === "string") {
      if ((size.chars += v.length) > 1_000_000) return invalid();
      return v;
    }
    if (v === null || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v) && !Object.is(v, -0)) return v;
    if (typeof v !== "object" || active.has(v)) return invalid();
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype || v.length > 65_536 : proto !== Object.prototype && proto !== null) return invalid();
    const keys = Reflect.ownKeys(v).filter(k => !(array && k === "length"));
    if (keys.length > 65_536 || array && keys.length !== v.length) return invalid();
    active.add(v);
    const result = array ? [] : Object.create(proto);
    originals?.set(result, v);
    for (const key of keys) {
      if (typeof key !== "string" || (size.chars += key.length) > 1_000_000
        || array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= v.length)) return invalid();
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!d.enumerable || !("value" in d)) return invalid();
      if (d.value === undefined && !array && (
        kind === "scenario" && optionalField(path, key)
        || kind === "declaration" && path.length === 1 && path[0] === "target"
          && ["role", "index", "nth", "selector", "collection"].includes(key)
        || kind === "judgment" && (!path.length && ["benign", "benignConsole", "localePrefixes", "requestMatch", "judgmentKey",
          "judgmentIntent", "opaque", "intent", "provenance"].includes(key)
          || path.length === 1 && path[0] === "requestMatch" && key === "allowedHosts")
      )) continue;
      Object.defineProperty(result, key, { value: copy(d.value, [...path, key]), enumerable: true, writable: true, configurable: true });
    }
    active.delete(v);
    return result;
  };
  return copy(input, []) as T;
}

/** Charge each acknowledged step to one recording before keeping its action data. */
export function snapshotCleanupSteps(steps: readonly Step[], size?: { nodes: number; chars: number }): readonly Step[] {
  return snapshot({steps}, "scenario", undefined, size).steps;
}

/** A keyed host action or check may look up its params in a Map, even when their values
 * can be serialized. Keep those references, including shared children. Verify their data
 * and identities synchronously after hashing so a concurrent edit cannot enter the plan. */
function bindCustomParams(plan: Scenario, source: Scenario, originals: WeakMap<object, object>): boolean {
  const unreadable = Symbol();
  const field = (object: unknown, key: PropertyKey): unknown => {
    if (!object || typeof object !== "object") return unreadable;
    const d = Object.getOwnPropertyDescriptor(object, key);
    return !d ? undefined : d.enumerable && "value" in d ? d.value : unreadable;
  };
  const matches = (copy: unknown, live: unknown): boolean => {
    if (!copy || typeof copy !== "object") return Object.is(copy, live);
    if (!live || typeof live !== "object" || originals.get(copy) !== live || Object.getPrototypeOf(copy) !== Object.getPrototypeOf(live)) return false;
    const keys = Object.keys(copy);
    return Reflect.ownKeys(live).length === keys.length + Number(Array.isArray(copy))
      && (!Array.isArray(copy) || Array.isArray(live) && copy.length === live.length)
      && keys.every(key => matches(field(copy, key), field(live, key)));
  };
  for (const section of ["steps", "assertions"] as const) {
    for (const [index, item] of plan[section].entries()) {
      if (item.kind !== "custom") continue;
      const owner = field(field(source, section), index);
      if (originals.get(item) !== owner) return false;
      const live = field(owner, "params");
      if (!matches(item.params, live)) return false;
      if (item.params !== undefined) item.params = live as typeof item.params;
    }
  }
  return true;
}

function eligible(s: Scenario): boolean {
  if (!s || typeof s.name !== "string" || !Array.isArray(s.steps) || s.steps.length < 2 || s.steps.length > maxSteps
    || !Array.isArray(s.assertions) || s.assertions.length > maxAssertions || s.truncated || s.truncationReason !== undefined
    || s.unprovenAction !== undefined || s.assertions.some(a => !a
      || !["navigated", "request-status", "no-console-errors", "no-failed-requests", "custom"].includes(a.kind))) return false;
  const pair = s.steps.slice(-2);
  return pair.every(step => step?.kind === "click" && step.expect === undefined && simpleTarget(step.target)
    && Object.keys(step).every(k => ["kind", "target", "intent"].includes(k)));
}

function simpleTarget(t: Target): boolean {
  return !!t && typeof t === "object" && boundedText(t.text, 512)
    && Object.keys(t).every(k => ["text", "role", "index"].includes(k))
    && (t.role === undefined || boundedText(t.role, 128))
    && (t.index === undefined || boundedText(t.role, 128) && Number.isSafeInteger(t.index) && t.index >= 0);
}
function sameTarget(a: Target, b: Target): boolean { return a.text === b.text && a.role === b.role && a.index === b.index; }
function repeat(s: Scenario): Target | undefined {
  if (!eligible(s)) return undefined;
  const [first, second] = s.steps.slice(-2);
  return first?.kind === "click" && second?.kind === "click" && sameTarget(first.target, second.target) ? second.target : undefined;
}
function history(s: Scenario, assertionCount: number, discoveryJudgment: string | null) {
  // Hosts may append assertions and restamp the judgment contract before approving the plan.
  const { assertions: _a, contract, ...rest } = s;
  return { body: rest, intentHash: contract?.intentHash ?? null, discoveryJudgment, assertions: s.assertions.slice(0, assertionCount) };
}

/** Called only after opt-in discovery has accounted for the original execution occurrences. */
export async function recordReplayCleanup(scenario: Scenario, reason?: DiscoveryRefusal): Promise<ReplayCleanupRecording> {
  if (reason !== undefined) return unavailable(refusals.has(reason) ? reason : "incomplete-recording");
  try {
    const s = snapshot(scenario, "scenario");
    if (!repeat(s)) return unavailable("unsupported-path");
    const assertionCount = s.assertions.length;
    const discoveryJudgment = isContractIdentity(s.contract) ? s.contract.fingerprint : null;
    const historyFingerprint = await fingerprint("history", history(s, assertionCount, discoveryJudgment));
    return { version: 1, status: "recorded", historyFingerprint, assertionCount, discoveryJudgment };
  } catch { return unavailable("unsupported-data"); }
}

function declarationMatches(d: ReplayCleanupDeclaration, target: Target, removed: number): boolean {
  return !!d && Object.keys(d).length === 5 && d.semantics === "idempotent-click" && d.repeatIndex === removed
    && boundedText(d.scope, 128) && boundedText(d.revision, 128) && simpleTarget(d.target) && sameTarget(d.target, target);
}

async function decide(s: Scenario, d: ReplayCleanupDeclaration): Promise<{ decision: ReplayCleanupDecision; plan?: Scenario }> {
  const target = repeat(s), removedIndex = s.steps.length - 1;
  if (!target) return { decision: declined("unsupported-path") };
  if (!declarationMatches(d, target, removedIndex)) return { decision: declined("invalid-declaration") };
  const plan = { ...s, steps: s.steps.slice(0, removedIndex) };
  const [sourceFingerprint, declarationFingerprint] = await Promise.all([
    fingerprint("source", s), fingerprint("declaration", d),
  ]);
  // A current declaration from a different approval cannot authorize this source by swapping
  // a digest field. The plan digest binds this particular source/declaration pair together.
  const planFingerprint = await fingerprint("plan", { sourceFingerprint, declarationFingerprint, plan });
  return { decision: { version: 1, status: "approved", reason: "declared-terminal-repeat",
    sourceFingerprint, planFingerprint, declarationFingerprint, mapping: { keptThrough: removedIndex - 1, removedIndex } }, plan };
}

/** Pure authoring operation. Produces an authorization sidecar, never a rewritten skill. */
export async function prepareReplayCleanup(scenario: Scenario, recording: ReplayCleanupRecording,
  declaration?: ReplayCleanupDeclaration): Promise<ReplayCleanupDecision> {
  try {
    const r = snapshot(recording);
    if (r?.version !== 1) return declined("recording-mismatch");
    if (r.status === "unavailable") return declined(refusals.has(r.reason) ? r.reason : "incomplete-recording");
    if (declaration === undefined) return declined("missing-declaration");
    const s = snapshot(scenario, "scenario"), d = snapshot(declaration, "declaration");
    if (!repeat(s)) return declined("unsupported-path");
    if (r.status !== "recorded" || !Number.isSafeInteger(r.assertionCount) || r.assertionCount < 0
      || r.assertionCount > s.assertions.length) return declined("recording-mismatch");
    if (!isContractIdentity(s.contract) || !s.contract.complete
      || (s.assertions.length > r.assertionCount && s.contract.fingerprint === r.discoveryJudgment)) return declined("unidentified-judgment");
    if (r.historyFingerprint !== await fingerprint("history", history(s, r.assertionCount, r.discoveryJudgment))) return declined("recording-mismatch");
    return (await decide(s, d)).decision;
  } catch { return declined("unsupported-data"); }
}

function blocked(p: ReplayCleanupProtection, removed: number): DeclineReason | undefined {
  if (p.differentStepMatchRules) return "unsupported-replay";
  if (p.stepHandlers !== undefined || p.stepHealer || p.screenshots) return "unsupported-replay";
  const n = p.protectedPrefixLength ?? 0;
  return !Number.isSafeInteger(n) || n < 0 || n > removed ? "protected-occurrence" : undefined;
}

/** Validate before dispatch. Refusal falls back to the complete input, never to a partial edit.
 * The approved path is detached, except for the checked params references received by a
 * custom host action or check, as in ordinary replay. */
export async function applyReplayCleanup(scenario: Scenario, options: ReplayCleanupOptions,
  protection: ReplayCleanupProtection = {}): Promise<Scenario> {
  protection.signal?.throwIfAborted();
  const notify = (decision: ReplayCleanupDecision) => {
    try { options.onDecision?.(decision); } catch { /* diagnostic only */ }
  };
  let decision: ReplayCleanupDecision = declined("stale-approval"), plan: Scenario | undefined;
  try {
    const originals = new WeakMap<object, object>();
    const s = snapshot(scenario, "scenario", originals), a = snapshot(options.approval), d = snapshot(options.declaration, "declaration");
    const judgment = protection.judgment === undefined ? undefined : snapshot(protection.judgment, "judgment");
    const reason = blocked(protection, s.steps.length - 1);
    if (reason) decision = declined(reason);
    else if (judgment && compareContracts(s.contract, await scenarioContract(s, judgment)) !== "same") decision = declined("stale-approval");
    else {
      const proposed = await decide(s, d), current = proposed.decision;
      if (current.status === "declined") decision = current;
      else if (a?.version === 1 && a.status === "approved" && a.reason === current.reason
        && a.sourceFingerprint === current.sourceFingerprint && a.planFingerprint === current.planFingerprint
        && a.declarationFingerprint === current.declarationFingerprint && a.mapping?.keptThrough === current.mapping.keptThrough
        && a.mapping.removedIndex === current.mapping.removedIndex && proposed.plan && bindCustomParams(proposed.plan, scenario, originals)) {
        decision = current;
        plan = proposed.plan;
      }
    }
  } catch { decision = declined("unsupported-data"); }
  protection.signal?.throwIfAborted();
  notify(decision);
  return plan ?? scenario;
}
