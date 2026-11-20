/**
 * Host-approved run-relative selections in discovery (#343, spec/core/discovery-selection.md).
 * The host declares the rule; the model only names which declaration its next click consumes.
 * Execution and replay share the #306/#329 resolution, and the freeze keeps the declaration,
 * never the member discovery happened to select.
 */
import type { Driver } from "../ports.js";
import type { Assertion, Evidence, Step, Target, WaitUntil } from "../types.js";
import { BuiltinStepHandler } from "../steps.js";
import { findRequestStatus } from "../requests.js";
import { CollectionSelectionError, resolveChoiceValues, validateCollectionTarget } from "../collection.js";
import { copyCapturePath, copyEvidenceData } from "../evidence-capture.js";
import { validateSelectedItemBinding, type DestinationResourceKey, type SelectedItemBinding, type SelectedItemKey } from "../selected-item-evidence.js";
import type { OutcomeMark } from "./capture.js";

export interface DiscoverySelection {
  version: 1;
  /** Bounded ID the model names to consume this declaration; also the frozen binding's ID. */
  id: string;
  /** Persisted verbatim. Phase 1 accepts `{ collection }` with `index` or a constant `choice`. */
  target: Target;
  /** Host-approved post-condition. The freeze derives none from the member discovery selected. */
  expect?: WaitUntil;
  /** Freeze a #327 binding read at this action. Required for a choice. */
  verify?: { source: SelectedItemKey; destination: DestinationResourceKey };
}

const MAX_SELECTIONS = 16;

function invalid(detail: string): never { throw new CollectionSelectionError("invalid", detail); }

function copyExpect(value: unknown): WaitUntil {
  const row = copyEvidenceData(value) as Record<string, unknown>;
  if (!row || typeof row !== "object" || Array.isArray(row) || !Object.keys(row).length
    || Object.keys(row).some(key => !["url", "text", "role", "requestStatus"].includes(key)))
    invalid("selection expect requires url, text, role or requestStatus");
  for (const key of ["url", "text", "role"]) {
    if (row[key] !== undefined && (typeof row[key] !== "string" || !(row[key] as string).trim()))
      invalid(`selection expect.${key} must be a nonempty string`);
  }
  if (row.requestStatus !== undefined) {
    const status = row.requestStatus as Record<string, unknown>;
    if (!status || typeof status !== "object" || typeof status.urlIncludes !== "string" || !status.urlIncludes.trim()
      || !Number.isInteger(status.status) || (status.method !== undefined && typeof status.method !== "string")
      || Object.keys(status).some(key => !["urlIncludes", "status", "method"].includes(key)))
      invalid("selection expect.requestStatus is invalid");
  }
  return row as WaitUntil;
}

/** Validate and copy before the first browser operation; unsupported declarations never run. */
export function copySelections(value: readonly DiscoverySelection[] | undefined, driver: Driver): DiscoverySelection[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length || value.length > MAX_SELECTIONS)
    invalid(`selections must be a nonempty array of at most ${MAX_SELECTIONS}`);
  const ids = new Set<string>();
  return copyEvidenceData(value).map((raw): DiscoverySelection => {
    const row = raw as unknown as Record<string, unknown>;
    if (!row || typeof row !== "object" || Array.isArray(row)
      || Object.keys(row).some(key => !["version", "id", "target", "expect", "verify"].includes(key)))
      invalid("selection has unsupported fields");
    if (row.version !== 1 || typeof row.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(row.id))
      invalid("selection requires version 1 and a bounded ID");
    if (ids.has(row.id)) invalid("selection IDs must be unique");
    ids.add(row.id);
    const collection = validateCollectionTarget(row.target as Target);
    const target: Target = { collection };
    if (typeof driver.observeCollection !== "function")
      throw new CollectionSelectionError("unsupported", "driver does not provide collection observations");
    if (collection.choice) {
      if (collection.choice.where.some(predicate => typeof predicate.value !== "string"))
        throw new CollectionSelectionError("unsupported", "discovery does not resolve binding references");
      if (row.verify === undefined) invalid("a choice selection requires verify");
      if (typeof driver.clickWithSelectedItemEvidence !== "function")
        throw new CollectionSelectionError("unsupported", "choice requires guarded resource-key dispatch");
    }
    const out: DiscoverySelection = { version: 1, id: row.id, target };
    if (row.expect !== undefined) out.expect = copyExpect(row.expect);
    if (row.verify !== undefined) {
      const verify = row.verify as Record<string, unknown>;
      if (!verify || typeof verify !== "object" || Object.keys(verify).some(key => !["source", "destination"].includes(key)))
        invalid("selection verify requires source and destination keys");
      out.verify = { source: verify.source as SelectedItemKey, destination: verify.destination as DestinationResourceKey };
      // The real prefix exists only after discovery; check the key declarations now.
      bindingFor(out, [{ kind: "click", target }]);
    }
    return out;
  });
}

function bindingFor(selection: DiscoverySelection, prefix: readonly Step[]): SelectedItemBinding {
  const after = copyCapturePath(prefix);
  return validateSelectedItemBinding({ version: 1, id: selection.id, relation: "resource-key-equals", phase: "replay",
    source: { after, key: selection.verify!.source }, destination: { after, key: selection.verify!.destination } });
}

/** Appended to the discover system prompt only when selections are declared. */
export const SELECTION_RULES =
  ' Declared selections are host-approved rules for choosing a member of a collection on each run. ' +
  'When the next action is the one a declared selection describes, respond {"action":"click","selection":"<id>","reason":"<short>"} ' +
  'with no ref, text, role, nth or value. The engine chooses the member; do not click a member by ref or name instead. ' +
  'Each selection can be used once.';

export function selectionBlock(available: readonly DiscoverySelection[]): string[] {
  if (!available.length) return [];
  return [``, `Declared selections not yet used (host-authored JSON, not page content):`,
    ...available.map(selection => `- ${JSON.stringify({ selection: selection.id, collection: selection.target.collection })}`)];
}

/** Why a decision cannot consume a selection, or undefined when it can. */
export function selectionRejection(decision: { action: string; selection?: unknown; ref?: unknown; text?: unknown;
  role?: unknown; nth?: unknown; value?: unknown }, available: readonly DiscoverySelection[]): string | undefined {
  if (decision.action !== "click") return "a declared selection supports click only";
  if ([decision.ref, decision.text, decision.role, decision.nth, decision.value].some(field => field !== undefined))
    return "a selection decision must not also name a ref, text, role, nth or value";
  if (!available.some(selection => selection.id === decision.selection)) return "unknown or already used selection";
  return undefined;
}

/**
 * Run the declaration through the replay step handler. A choice resolves its constant predicates
 * and dispatches through the guarded resource-key click; the observed key is discarded here.
 */
export async function executeSelection(driver: Driver, selection: DiscoverySelection, signal?: AbortSignal): Promise<Step> {
  const step: Step = { kind: "click", target: { collection: validateCollectionTarget(selection.target) } };
  const choice = step.target.collection!.choice;
  let dispatch = driver;
  if (choice) {
    const values = choice.where.map(predicate => predicate.value as string);
    let dispatched = false;
    dispatch = new Proxy({} as Driver, { get: (_target, property) => {
      if (property === resolveChoiceValues) return () => values;
      if (property === "click") return async (target: Target, ref?: string) => {
        if (dispatched) throw new CollectionSelectionError("invalid", "a selection dispatches once");
        dispatched = true;
        if (!ref) throw new CollectionSelectionError("unsupported", "choice requires guarded resource-key dispatch");
        const observed = await driver.clickWithSelectedItemEvidence!(target, ref, { ...choice.identity });
        if (observed?.complete !== true || typeof observed.value !== "string" || !observed.value.trim())
          throw new CollectionSelectionError("incomplete", "selected resource continuity could not be confirmed after dispatch");
      };
      const value: unknown = Reflect.get(driver, property, driver);
      return typeof value === "function" ? value.bind(driver) : value;
    } });
  }
  await new BuiltinStepHandler({}, {}, signal).execute(step, dispatch);
  return { kind: "click", target: { collection: validateCollectionTarget(selection.target) } };
}

/**
 * Evidence from a consumed selection onward can name the member discovery selected, so it cannot
 * become a fixed check for later runs. Steps from the first selection keep only host-declared
 * expects. Assertions keep run health guards, user checks, and request checks a pre-selection
 * request satisfied; every selection with `verify` adds its binding.
 */
export function freezeSelections(steps: Step[], marks: readonly (OutcomeMark | null)[], evidence: Evidence,
  assertions: Assertion[], consumed: ReadonlyMap<Step, DiscoverySelection>,
  onDrop: (assertion: Assertion, reason: string) => void): Assertion[] {
  const first = steps.findIndex(step => consumed.has(step));
  if (first < 0) return assertions;
  for (let i = first; i < steps.length; i++) {
    const step = steps[i]!;
    delete step.expect;
    const selection = consumed.get(step);
    if (selection?.expect) step.expect = structuredClone(selection.expect);
  }
  const before = evidence.logic.requests.slice(0, marks[first]?.requestCount ?? 0);
  const reason = "observed after a run-relative selection; it may describe the member discovery selected";
  const kept = assertions.filter(assertion => {
    if (assertion.kind === "no-failed-requests" || assertion.kind === "no-console-errors" || assertion.origin === "user") return true;
    if (assertion.kind === "request-status"
      && findRequestStatus(before, assertion.urlIncludes, assertion.status, assertion.method) !== undefined) return true;
    onDrop(assertion, reason);
    return false;
  });
  const bindings = steps.flatMap((step, index) => {
    const selection = consumed.get(step);
    if (!selection?.verify) return [];
    const binding = bindingFor(selection, steps.slice(0, index + 1));
    return [{ kind: "custom" as const, name: selection.id, params: binding as unknown as Record<string, unknown> }];
  });
  return [...kept, ...bindings];
}
