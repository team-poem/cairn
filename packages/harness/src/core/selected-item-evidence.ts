import type { Driver } from "./ports.js";
import type { CollectionTarget, Evidence, ExecutedAction, Scenario, Step } from "./types.js";
import { copyCapturePath, copyEvidenceData, sameCapturePath } from "./evidence-capture.js";
import { hashContractValue } from "./contract.js";
import { CollectionSelectionError, resolveChoiceValues, resolveCollectionTarget, SelectionNotDispatchedError, validateCollectionTarget } from "./collection.js";
import { rethrowBudget } from "./budget.js";

/** Explicit application-owned resource key. Never inferred from a label or URL. */
export interface SelectedItemKey {
  kind: "attribute";
  scope: "item" | "action";
  attribute: string;
}
export interface DestinationResourceKey {
  kind: "attribute";
  selector: string;
  attribute: string;
}
/** A Driver must return complete only for one independently observed, bounded resource key. */
export interface ResourceKeyObservation { complete: boolean; value?: string }

/** Persist this declaration in custom assertion params, never observed values or references. */
export interface SelectedItemBinding {
  version: 1;
  id: string;
  relation: "resource-key-equals";
  phase: "replay";
  source: { after: readonly Step[]; key: SelectedItemKey };
  destination: { after: readonly Step[]; key: DestinationResourceKey };
}
export interface SelectedItemEvidenceOptions {
  bindings: readonly SelectedItemBinding[];
  /** Acceptance deadline per source dispatch / destination read; in-flight calls always drain. */
  timeoutMs?: number;
}
export interface SelectedItemEvidenceRecord {
  id: string;
  runId: string;
  phase: "replay";
  contractFingerprint: string;
  sourceActionId?: string;
  destinationActionId?: string;
  status: "captured" | "unavailable" | "timed-out" | "cancelled" | "skipped";
  complete: boolean;
  /** Only a complete comparison has a result. Raw keys stay inside the invocation. */
  equal?: boolean;
  /** Bounded pre-dispatch selection attempts. No resource values or browser references. */
  selectionAttempts?: SelectedItemSelectionAttempt[];
  sourceAttemptId?: string;
}
export interface SelectedItemSelectionAttempt {
  id: string;
  actionId: string;
  dispatch: "not-dispatched" | "dispatched" | "unknown";
}

function fields(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) throw new Error("invalid selected-item binding fields");
}
function attribute(value: unknown): void {
  if (typeof value !== "string" || value.length > 128 || !/^data-[a-z][a-z0-9-]*$/.test(value))
    throw new Error("selected-item keys require an explicit data-* attribute");
}
export function validateSelectedItemBinding(value: unknown): SelectedItemBinding {
  const row = copyEvidenceData(value);
  fields(row, ["version", "id", "relation", "phase", "source", "destination"]);
  if (row.version !== 1 || row.relation !== "resource-key-equals" || row.phase !== "replay"
    || typeof row.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(row.id))
    throw new Error("selected-item bindings require version 1, a bounded ID, resource-key-equals and replay phase");
  fields(row.source, ["after", "key"]);
  fields(row.destination, ["after", "key"]);
  const source = row.source, destination = row.destination;
  for (const point of [source, destination]) {
    if (!Array.isArray(point.after) || !point.after.length || point.after.length > 1_000
      || !sameCapturePath(point.after as Step[], point.after as Step[]))
      throw new Error("selected-item bindings require bounded, nonempty action prefixes");
  }
  const before = source.after as Step[], after = destination.after as Step[];
  const click = before.at(-1)!;
  if (click.kind !== "click" || !click.target?.collection)
    throw new Error("selected-item evidence supports collection click sources only");
  validateCollectionTarget(click.target);
  if (after.length < before.length || !sameCapturePath(before, after.slice(0, before.length)))
    throw new Error("selected-item destination must extend its source action prefix");
  fields(source.key, ["kind", "scope", "attribute"]);
  fields(destination.key, ["kind", "selector", "attribute"]);
  if (source.key.kind !== "attribute" || !["item", "action"].includes(source.key.scope as string)
    || destination.key.kind !== "attribute" || typeof destination.key.selector !== "string"
    || !destination.key.selector.trim() || destination.key.selector.length > 512)
    throw new Error("unsupported selected-item key extraction");
  attribute(source.key.attribute);
  attribute(destination.key.attribute);
  const choice = click.target.collection.choice;
  if (choice && (choice.where.some(predicate => typeof predicate.value !== "string")
    || source.key.kind !== choice.identity.kind || source.key.scope !== choice.identity.scope
    || source.key.attribute !== choice.identity.attribute))
    throw new Error("a choice binding requires constant predicates and its declared identity key");
  return row as unknown as SelectedItemBinding;
}

/** Invalid/partial adapter data never becomes a matching empty key. */
function keyOf(value: ResourceKeyObservation): string | undefined {
  try {
    const row = copyEvidenceData(value);
    return row.complete === true && typeof row.value === "string" && row.value.trim().length > 0
      && row.value.length <= 256 ? row.value : undefined;
  } catch { return undefined; }
}
async function fingerprint(binding: SelectedItemBinding): Promise<string> {
  return hashContractValue(binding);
}

/** Register as a custom check. Missing evidence is required inconclusive, not an app failure. */
export async function selectedItemEquals(params: Record<string, unknown>, evidence: Evidence): Promise<
  { passed: boolean; detail: string } | { inconclusive: true; required: true; detail: string }
> {
  const unavailable = { inconclusive: true as const, required: true as const, detail: "selected-item resource equality could not be confirmed" };
  try {
    const binding = validateSelectedItemBinding(params);
    if (!evidence.selectedItemRunId) return unavailable;
    const matches = evidence.selectedItems?.filter(row => row.id === binding.id && row.runId === evidence.selectedItemRunId
      && row.phase === binding.phase);
    if (matches?.length !== 1) return unavailable;
    const row = matches[0]!;
    if (row.status !== "captured" || !row.complete || typeof row.equal !== "boolean"
      || row.contractFingerprint !== await fingerprint(binding)
      || row.sourceActionId !== `${row.runId}:${binding.source.after.length - 1}`
      || row.destinationActionId !== `${row.runId}:${binding.destination.after.length - 1}`) return unavailable;
    const source = binding.source.after.at(-1)!;
    if (source.kind === "click" && source.target.collection?.choice) {
      const attempts = row.selectionAttempts?.filter(attempt => attempt.actionId === row.sourceActionId);
      if (!attempts?.length || attempts.length > source.target.collection.choice.maxReselections + 1
        || attempts.some((attempt, index) => attempt.id !== `${row.sourceActionId}:selection:${index}`
          || attempt.dispatch !== (index === attempts.length - 1 ? "dispatched" : "not-dispatched"))
        || row.sourceAttemptId !== attempts.at(-1)?.id) return unavailable;
    }
    return { passed: row.equal, detail: row.equal ? "destination resource key matches the selected item"
      : "destination resource key differs from the selected item" };
  } catch { return unavailable; }
}

interface Pending {
  binding: SelectedItemBinding;
  record: SelectedItemEvidenceRecord;
  key?: string;
  provisional?: string;
  sourceStatus?: SelectedItemEvidenceRecord["status"];
  dispatched?: boolean;
  done?: boolean;
}

function captureInterrupted(status: SelectedItemEvidenceRecord["status"]): boolean {
  return status === "timed-out" || status === "cancelled";
}

/** Run-local ownership at the existing Execute boundary; never a second action scheduler. */
export class SelectedItemEvidenceSession {
  readonly runId = globalThis.crypto.randomUUID();
  private readonly pending: Pending[];
  private readonly path: Step[] = [];
  private invalid = false;
  private readonly timeoutMs: number;

  constructor(options: SelectedItemEvidenceOptions) {
    this.timeoutMs = options.timeoutMs ?? 2_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("selected-item timeoutMs must be positive and finite");
    if (!Array.isArray(options.bindings) || options.bindings.length > 32) throw new Error("selected-item evidence supports at most 32 bindings");
    const bindings = copyEvidenceData(options.bindings).map(validateSelectedItemBinding);
    const ids = new Set<string>(), indices = new Set<number>();
    for (const binding of bindings) {
      if (ids.has(binding.id) || indices.has(binding.source.after.length))
        throw new Error("selected-item bindings require unique IDs and one binding per source occurrence");
      ids.add(binding.id); indices.add(binding.source.after.length);
    }
    this.pending = bindings.map(binding => ({ binding, record: { id: binding.id, runId: this.runId, phase: "replay",
      contractFingerprint: "", status: "skipped", complete: false } }));
  }

  /** Refuse unsupported authoring before any browser action, including missing persisted intent. */
  validateScenario(scenario: Pick<Scenario, "steps" | "assertions">): void {
    for (const [index, step] of scenario.steps.entries()) {
      if (!("target" in step) || !step.target.collection?.choice) continue;
      if (step.kind !== "click") throw new CollectionSelectionError("unsupported", "predicate selection supports click steps only");
      const choice = validateCollectionTarget(step.target).choice!;
      const prefix = scenario.steps.slice(0, index + 1);
      const references = choice.where.flatMap(predicate => typeof predicate.value === "string" ? [] : [predicate.value.bindingId]);
      const point = references.length ? this.pending.find(p => p.binding.id === references[0])
        : this.pending.find(p => sameCapturePath(p.binding.source.after, prefix));
      if (!point || (references.length > 0 && (point.binding.source.after.length > index
        || point.binding.destination.after.length <= index
        || !sameCapturePath(point.binding.source.after, prefix.slice(0, point.binding.source.after.length))
        || !sameCapturePath(prefix, point.binding.destination.after.slice(0, prefix.length)))))
        throw new CollectionSelectionError("invalid", "choice requires a matching source binding or a live earlier binding reference");
      const persisted = scenario.assertions.some(assertion => assertion.kind === "custom" && assertion.params
        && sameCapturePath([{ kind: "custom", name: "binding", params: assertion.params }],
          [{ kind: "custom", name: "binding", params: point.binding as unknown as Record<string, unknown> }]));
      if (!persisted) throw new CollectionSelectionError("invalid", "choice binding must be persisted in a custom assertion");
    }
  }

  /** Intercept the exact source or dependent choice. Only proven non-dispatch permits reselection. */
  driverFor(step: Step, driver: Driver, signal?: AbortSignal): Driver {
    const candidate = this.pending.find(p => p.binding.source.after.length === this.path.length + 1);
    const point = candidate && !this.invalid && sameCapturePath(candidate.binding.source.after, [...this.path, step]) ? candidate : undefined;
    const selection = "target" in step && step.target.collection?.choice ? validateCollectionTarget(step.target) : undefined;
    const choice = selection?.choice;
    if (!point && !choice) return driver;
    let dependency: Pending | undefined;
    const resolveValues = (input: CollectionTarget): readonly string[] => {
      signal?.throwIfAborted();
      if (!choice || !selection || this.invalid || step.kind !== "click"
        || !sameCapturePath([{ kind: "click", target: { collection: input } }], [{ kind: "click", target: { collection: selection } }]))
        throw new CollectionSelectionError("unsupported", "choice requires a valid replay binding at this action");
      if (typeof driver.clickWithSelectedItemEvidence !== "function")
        throw new CollectionSelectionError("unsupported", "choice requires guarded resource-key dispatch");
      const references = choice.where.flatMap(predicate => typeof predicate.value === "string" ? [] : [predicate.value.bindingId]);
      if (!references.length) {
        if (!point || point.binding.source.key.scope !== choice.identity.scope
          || point.binding.source.key.attribute !== choice.identity.attribute)
          throw new CollectionSelectionError("invalid", "choice requires its matching source binding");
      } else {
        dependency = this.pending.find(p => p.binding.id === references[0]);
        if (point || !dependency || dependency.done || dependency.key === undefined
          || dependency.record.status !== "captured" || !dependency.record.sourceActionId
          || dependency.binding.source.after.length > this.path.length
          || !sameCapturePath(dependency.binding.source.after, this.path.slice(0, dependency.binding.source.after.length))
          || !sameCapturePath([...this.path, step], dependency.binding.destination.after.slice(0, this.path.length + 1)))
          throw new CollectionSelectionError("unsupported", "selected resource is unavailable at this action");
      }
      return choice.where.map(predicate => typeof predicate.value === "string" ? predicate.value : dependency!.key!);
    };
    let calls = 0;
    const wrapped: Driver = new Proxy({} as Driver, { get: (_target, property) => {
      const inner = driver;
      if (property === resolveChoiceValues) return resolveValues;
      if (property === "click") return async (target: Parameters<Driver["click"]>[0], ref?: string) => {
        if (++calls > 1) throw new Error("selected-item evidence does not allow a repeated dispatch");
        if (choice) resolveValues(selection!);
        if (point) point.dispatched = true;
        if (!ref || typeof inner.clickWithSelectedItemEvidence !== "function") {
          if (choice) throw new CollectionSelectionError("unsupported", "choice requires guarded resource-key dispatch");
          point!.sourceStatus = "unavailable";
          return inner.click(target, ref);
        }
        const started = performance.now();
        const owner = point ?? dependency!;
        const interruptCapture = (status: "timed-out" | "cancelled") => {
          owner.record.status = status;
          owner.record.complete = false;
          delete owner.record.equal;
          if (point) point.sourceStatus = status;
        };
        const actionId = `${this.runId}:${this.path.length}`;
        for (let index = 0; ; index++) {
          signal?.throwIfAborted();
          const attempt: SelectedItemSelectionAttempt | undefined = choice ? {
            id: `${actionId}:selection:${index}`, actionId, dispatch: "unknown",
          } : undefined;
          if (attempt) (owner.record.selectionAttempts ??= []).push(attempt);
          try {
            const observed = await inner.clickWithSelectedItemEvidence(target, ref, copyEvidenceData(choice?.identity ?? point!.binding.source.key));
            if (attempt) attempt.dispatch = "dispatched";
            const status = signal?.aborted ? "cancelled" : performance.now() - started >= this.timeoutMs ? "timed-out" : "captured";
            if (status !== "captured") interruptCapture(status);
            const key = status === "captured" ? keyOf(observed) : undefined;
            if (point) {
              point.dispatched = true;
              point.sourceStatus = status === "captured" && key === undefined ? "unavailable" : status;
              point.provisional = key;
              if (attempt) point.record.sourceAttemptId = attempt.id;
            }
            if (choice && (key === undefined || (dependency && key !== dependency.key)))
              throw new CollectionSelectionError("incomplete", "selected resource continuity could not be confirmed after dispatch");
            return;
          } catch (error) {
            if (signal?.aborted) interruptCapture("cancelled");
            if (point) {
              delete point.provisional;
              if (!captureInterrupted(owner.record.status)) point.sourceStatus = "unavailable";
            }
            if (!(choice && error instanceof SelectionNotDispatchedError && error.ref === ref)) throw error;
            if (attempt) attempt.dispatch = "not-dispatched";
            if (point) point.dispatched = false;
            if (performance.now() - started >= this.timeoutMs) { interruptCapture("timed-out"); throw error; }
            if (index >= choice.maxReselections) throw error;
            signal?.throwIfAborted();
            // Fresh observation only. Never re-run an earlier action or retry an uncertain click.
            const resolved = await resolveCollectionTarget(wrapped, { collection: selection! });
            target = resolved.target; ref = resolved.ref;
            if (performance.now() - started >= this.timeoutMs) {
              interruptCapture("timed-out");
              throw new CollectionSelectionError("stale", "selection acceptance deadline expired before dispatch");
            }
          }
        }
      };
      const value: unknown = Reflect.get(inner, property, inner);
      return typeof value === "function" ? value.bind(inner) : value;
    } });
    return wrapped;
  }

  async after(action: ExecutedAction, driver: Driver, signal?: AbortSignal): Promise<void> {
    if (this.pending.every(p => p.done)) return;
    try { this.path.push(copyCapturePath([action.step])[0]!); }
    catch { this.invalid = true; }
    if (!action.ok || action.skipped) this.invalid = true;
    const index = this.path.length - 1;
    for (const point of this.pending) {
      if (point.done) continue;
      const { binding, record } = point;
      if (!record.contractFingerprint) {
        try { record.contractFingerprint = await fingerprint(binding); } catch { this.invalid = true; }
      }
      if (binding.source.after.length === this.path.length) {
        if (!this.invalid && point.dispatched && sameCapturePath(binding.source.after, this.path)) {
          point.key = point.provisional;
          record.sourceActionId = `${this.runId}:${index}`;
          record.status = point.sourceStatus ?? "unavailable";
        } else if (!captureInterrupted(record.status)) record.status = "unavailable";
        delete point.provisional;
      }
      if (binding.destination.after.length !== this.path.length) continue;
      point.done = true;
      if (this.invalid || !sameCapturePath(binding.destination.after, this.path) || point.key === undefined) {
        if (record.status === "captured" || record.status === "skipped") record.status = "unavailable";
        delete point.key;
        continue;
      }
      record.destinationActionId = `${this.runId}:${index}`;
      const started = performance.now();
      try {
        if (signal?.aborted) { record.status = "cancelled"; continue; }
        if (typeof driver.readResourceKey !== "function") { record.status = "unavailable"; continue; }
        const observed = await driver.readResourceKey(copyEvidenceData(binding.destination.key));
        const actual = keyOf(observed);
        record.status = signal?.aborted ? "cancelled" : performance.now() - started >= this.timeoutMs ? "timed-out"
          : actual === undefined ? "unavailable" : "captured";
        if (record.status === "captured") { record.equal = point.key === actual; record.complete = true; }
      } catch (error) { record.status = signal?.aborted ? "cancelled" : "unavailable"; rethrowBudget(error); }
      finally { delete point.key; }
    }
  }

  finish(signal?: AbortSignal): SelectedItemEvidenceRecord[] {
    for (const point of this.pending) {
      delete point.key; delete point.provisional;
      if (!point.done) {
        if (!captureInterrupted(point.record.status)) point.record.status = signal?.aborted ? "cancelled" : "skipped";
        point.done = true;
      }
    }
    return this.pending.map(p => ({ ...p.record,
      ...(p.record.selectionAttempts ? { selectionAttempts: p.record.selectionAttempts.map(attempt => ({ ...attempt })) } : {}) }));
  }
}
