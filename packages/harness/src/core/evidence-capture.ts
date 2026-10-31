import type { Driver } from "./ports.js";
import type { Evidence, ExecutedAction, PageElement, Step } from "./types.js";
import { slotSecretText, type Secrets } from "./secrets.js";
import { hashContractValue } from "./contract.js";

export type CapturePhase = "replay" | "discover" | "heal";
export type CaptureStatus = "captured" | "unavailable" | "timed-out" | "cancelled" | "skipped";

/** Runtime selection, NOT a verification contract. A required check belongs in an assertion. */
export interface EvidenceCheckpoint {
  id: string;
  /** Exact action prefix ending at this boundary. intent/expect metadata is ignored; action
   * parameters are not. A changed/healed prefix must be explicitly rebound by the consumer. */
  after: readonly Step[];
  phase?: CapturePhase;
  elements?: boolean;
  screenshot?: boolean;
}

export interface EvidenceCaptureOptions {
  checkpoints: readonly EvidenceCheckpoint[];
  /** Acceptance deadline, including settling. In-flight driver calls drain before continuing. */
  timeoutMs?: number;
  /** Optional settling BEFORE the capture; never substitutes for a step's post-condition. */
  settle?: boolean;
  /** Sensitive fields are excluded unless explicitly allowed. Pixels cannot be auto-redacted. */
  includeValues?: boolean;
  /** Synchronous notification only. Returned promises are not awaited. No browser work here. */
  onCapture?: (record: EvidenceCheckpointRecord) => void;
}

export interface EvidenceCheckpointRecord {
  id: string;
  runId: string;
  phase: CapturePhase;
  boundary: "after-step";
  /** Unique per completed execution occurrence, not a persistent scenario step ID. */
  actionId?: string;
  index?: number;
  action?: ExecutedAction;
  /** The actual completed path at this boundary, including healed replacements. */
  path: Step[];
  /** SHA-256 of the validated, unredacted action prefix; display fields are not binding inputs. */
  pathFingerprint?: string;
  status: CaptureStatus;
  reason?: "not-reached" | "path-changed" | "step-skipped" | "step-failed" | "capture-failed" | "unsupported-path";
  elapsedMs: number;
  /** Completeness means requested reads completed, NOT whole-page coverage or atomicity. */
  complete: boolean;
  coverage: "driver-snapshot";
  /** Driver snapshots do not promise document identity or atomic screenshot/DOM pairing. */
  documentIdentity: "unknown";
  elements?: Array<Pick<PageElement, "role" | "name" | "checked" | "disabled" | "value">>;
  screenshot?: string;
}

function canonical(value: unknown, parents = new Set<object>(), depth = 0): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return JSON.stringify(value);
  if (typeof value !== "object" || parents.has(value) || depth > 100)
    throw new Error("evidence capture paths must contain finite, acyclic JSON data");
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new Error("evidence capture paths must contain plain JSON objects");
  const keys = Reflect.ownKeys(value).filter(key => !(array && key === "length"));
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined
      || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))
      throw new Error("evidence capture paths must contain plain JSON data properties");
  }
  if (array && keys.length !== value.length) throw new Error("evidence capture paths must not contain sparse arrays");
  parents.add(value);
  const read = (key: string) => canonical(Object.getOwnPropertyDescriptor(value, key)!.value, parents, depth + 1);
  const result = array ? `[${Array.from({ length: value.length }, (_, i) => read(String(i))).join(",")}]`
    : `{${(keys as string[]).sort().map(key => `${JSON.stringify(key)}:${read(key)}`).join(",")}}`;
  parents.delete(value);
  return result;
}

function actionData(step: Step): Step {
  // Never invoke getters while recording an already executed action. Only metadata is ignored.
  const descriptors = Object.getOwnPropertyDescriptors(step);
  delete descriptors.intent;
  delete descriptors.expect;
  // Discovery emits an omitted scroll direction as an explicit undefined property.
  for (const key of ["direction", "timeoutMs"] as const)
    if (descriptors[key] && "value" in descriptors[key]! && descriptors[key]!.value === undefined) delete descriptors[key];
  return JSON.parse(canonical(Object.create(Object.getPrototypeOf(step), descriptors))) as Step;
}

function pathData(path: readonly Step[]): Step[] {
  if (!Array.isArray(path)) throw new Error("evidence capture requires an action prefix");
  return path.map(actionData);
}

/** Compare action data, not discovery's subsequently assigned readiness/intent metadata. */
export function sameCapturePath(a: readonly Step[], b: readonly Step[]): boolean {
  try { return canonical(pathData(a)) === canonical(pathData(b)); } catch { return false; }
}

/** Resolve a current-run, complete checkpoint against a separately declared verification plan.
 * Missing evidence is NOT a passed check. The host must return required inconclusive when absent. */
export async function checkpointEvidence(evidence: Evidence, point: Pick<EvidenceCheckpoint, "id" | "after" | "phase">): Promise<EvidenceCheckpointRecord | undefined> {
  if (!evidence.captureRunId) return undefined;
  const matches = evidence.checkpoints?.filter(record => record.id === point.id && record.runId === evidence.captureRunId
    && record.phase === (point.phase ?? "replay"));
  if (matches?.length !== 1) return undefined;
  const record = matches[0]!;
  if (record.status !== "captured" || !record.complete || !record.action?.ok || record.action.skipped) return undefined;
  try { return record.pathFingerprint === await hashContractValue(pathData(point.after)) ? record : undefined; }
  catch { return undefined; }
}

/** Per-invocation owner. No detached capture jobs, no previous-run cache, no browser callback. */
export class EvidenceCaptureSession {
  readonly runId = globalThis.crypto.randomUUID();
  readonly records: EvidenceCheckpointRecord[] = [];
  private readonly path: Step[] = [];
  private readonly options: EvidenceCaptureOptions;
  private readonly pending: EvidenceCheckpoint[];
  private invalidPrefix?: "step-skipped" | "step-failed";

  constructor(options: EvidenceCaptureOptions, private readonly phase: CapturePhase, private readonly secrets?: Secrets) {
    const timeoutMs = options.timeoutMs ?? 2_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("evidence capture timeoutMs must be positive and finite");
    if (options.checkpoints.length > 100) throw new Error("evidence capture supports at most 100 checkpoints per invocation");
    const ids = new Set<string>();
    for (const point of options.checkpoints) {
      if (!point.id || ids.has(point.id) || !point.after.length || (!point.elements && !point.screenshot))
        throw new Error("evidence checkpoints require unique IDs, a nonempty action prefix and selected data");
      ids.add(point.id);
      canonical(pathData(point.after)); // reject unsupported selection data before any mutation
    }
    this.options = { ...options, timeoutMs };
    this.pending = structuredClone(options.checkpoints.filter(p => (p.phase ?? "replay") === phase));
  }

  private publish(record: EvidenceCheckpointRecord): void {
    const redact = (value: unknown): unknown => typeof value === "string" ? slotSecretText(value, this.secrets)
      : Array.isArray(value) ? value.map(redact) : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)])) : value;
    const redactStep = (step: Step): Step => {
      const safe = redact(step) as Step;
      safe.kind = step.kind;
      if (safe.kind === "scroll" && step.kind === "scroll" && step.direction !== undefined) safe.direction = step.direction;
      if ("target" in safe && "target" in step) {
        if (step.target.role !== undefined) safe.target.role = step.target.role;
        const original = step.target.collection;
        const collection = safe.target.collection;
        if (original && collection) {
          collection.itemRole = original.itemRole;
          collection.order = original.order;
          collection.root.role = original.root.role;
          collection.target.role = original.target.role;
          collection.conditions?.forEach((condition, index) => {
            const before = original.conditions![index]!;
            condition.control.role = before.control.role;
            if (before.checked !== undefined) condition.checked = before.checked;
          });
        }
      }
      if (safe.kind === "waitFor" && step.kind === "waitFor" && step.until.role !== undefined) safe.until.role = step.until.role;
      return safe;
    };
    const safe: EvidenceCheckpointRecord = { ...record, path: record.path.map(redactStep),
      ...(record.action ? { action: { ...record.action, step: redactStep(record.action.step),
        ...(record.action.error ? { error: slotSecretText(record.action.error, this.secrets) } : {}) } } : {}),
      ...(record.elements ? { elements: record.elements.map(element => ({ ...redact(element) as typeof element,
        role: element.role, ...(element.checked !== undefined ? { checked: element.checked } : {}) })) } : {}),
    };
    this.records.push(safe);
    // Notification errors cannot turn a successful mutation into a failed/retried action.
    try { Promise.resolve(this.options.onCapture?.(structuredClone(safe))).catch(() => {}); } catch { /* observer only */ }
  }

  private record(point: EvidenceCheckpoint): EvidenceCheckpointRecord {
    return { id: point.id, runId: this.runId, phase: this.phase, boundary: "after-step",
      path: structuredClone(this.path), status: "skipped", complete: false, elapsedMs: 0,
      coverage: "driver-snapshot", documentIdentity: "unknown" };
  }

  async after(action: ExecutedAction, driver: Driver, signal?: AbortSignal,
    legacyScreenshot?: () => Promise<string | undefined>): Promise<void> {
    if (this.pending.length === 0) return;
    let step: Step;
    try { step = actionData(action.step); }
    catch {
      for (const point of this.pending.splice(0)) this.publish({ ...this.record(point), status: "unavailable", reason: "unsupported-path" });
      return;
    }
    this.path.push(step);
    if (action.skipped) this.invalidPrefix = "step-skipped";
    else if (!action.ok) this.invalidPrefix = "step-failed";
    const index = this.path.length - 1;
    const selected = this.pending.filter(p => p.after.length === this.path.length);
    for (const point of selected) this.pending.splice(this.pending.indexOf(point), 1);
    // At a shared boundary all selected checkpoints reuse one read, including legacy screenshots.
    let elements: Promise<PageElement[]> | undefined;
    let screenshot: Promise<string | undefined> | undefined;
    let settled: Promise<void> | undefined;
    const started = performance.now();
    let pathFingerprint: string | undefined;
    try { if (selected.length) pathFingerprint = await hashContractValue(this.path); } catch { /* diagnostic only */ }
    for (const point of selected) {
      const record = { ...this.record(point), index, ...(action.skipped ? {} : { actionId: `${this.runId}:${index}` }),
        pathFingerprint, action: { step, ok: action.ok, ...(action.skipped ? { skipped: true } : {}),
          ...(action.errorKind ? { errorKind: action.errorKind } : {}) } };
      if (!pathFingerprint) { record.status = "unavailable"; record.reason = "unsupported-path"; }
      else if (!sameCapturePath(point.after, this.path)) record.reason = "path-changed";
      else if (this.invalidPrefix) record.reason = this.invalidPrefix;
      else {
        const expired = () => performance.now() - started >= this.options.timeoutMs!;
        try {
          if (!signal?.aborted && !expired() && this.options.settle) await (settled ??= driver.settle());
          if (!signal?.aborted && !expired() && point.elements) {
            const rows = await (elements ??= driver.snapshot());
            if (rows.length > 10_000) throw new Error("checkpoint snapshot exceeds row limit");
            record.elements = rows.map(({ role, name, checked, disabled, value }) => ({ role, name,
              ...(checked !== undefined ? { checked } : {}), ...(disabled !== undefined ? { disabled } : {}),
              ...(this.options.includeValues && value !== undefined ? { value } : {}) }));
          }
          if (!signal?.aborted && !expired() && point.screenshot)
            record.screenshot = await (screenshot ??= legacyScreenshot ? legacyScreenshot() : driver.screenshot());
          if (JSON.stringify(record).length > 10_000_000) throw new Error("checkpoint exceeds payload limit");
          record.status = signal?.aborted ? "cancelled" : expired() ? "timed-out"
            : point.screenshot && record.screenshot === undefined ? "unavailable" : "captured";
        } catch {
          record.status = signal?.aborted ? "cancelled" : expired() ? "timed-out" : "unavailable";
          record.reason = "capture-failed";
        }
        record.complete = record.status === "captured";
        if (!record.complete) { delete record.elements; delete record.screenshot; }
        record.elapsedMs = performance.now() - started;
      }
      this.publish(record);
    }
  }

  finish(signal?: AbortSignal): EvidenceCheckpointRecord[] {
    for (const point of this.pending.splice(0)) this.publish({ ...this.record(point),
      status: signal?.aborted ? "cancelled" : "skipped", reason: "not-reached" });
    return structuredClone(this.records);
  }

  /** Discovery could dispatch and then fail before returning a Step. Do not infer its effects. */
  invalidate(): void { this.invalidPrefix = "step-failed"; }
}
