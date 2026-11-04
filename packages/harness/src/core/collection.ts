/** Explicit collection selection. Drivers measure; core validates; no model or fallback. */
import type { Driver } from "./ports.js";
import type { CollectionChoice, CollectionChoicePredicate, CollectionCondition, CollectionLocator, CollectionResourceKey, CollectionTarget, Step, Target } from "./types.js";

export type CollectionSelectionCode = "invalid" | "unsupported" | "incomplete" | "condition" | "missing" | "disabled" | "stale" | "ambiguous";

export class CollectionSelectionError extends Error {
  override readonly name = "CollectionSelectionError";
  readonly kind: "handler" | "resolution";
  constructor(readonly code: CollectionSelectionCode, detail: string) {
    super(`collection selection ${code}: ${detail}`);
    this.kind = ["invalid", "unsupported", "incomplete", "condition"].includes(code) ? "handler" : "resolution";
  }
}

/** Internal session hook. The runtime key never becomes part of the saved target or trace. */
export const resolveChoiceValues = Symbol("cairn.resolveChoiceValues");
export interface CollectionChoiceResolver {
  [resolveChoiceValues](selection: CollectionTarget): readonly string[] | Promise<readonly string[]>;
}

/** Only an adapter that has not dispatched the action may throw this retryable refusal. */
export class SelectionNotDispatchedError extends CollectionSelectionError {
  constructor(readonly ref: string) { super("stale", "candidate changed before dispatch"); }
}

/** Includes malformed declarations: invalid data must never opt into legacy fallback/healing. */
export function isCollectionStep(step: Step): boolean {
  return "target" in step && step.target != null && typeof step.target === "object" && "collection" in step.target;
}

function invalid(detail: string): never { throw new CollectionSelectionError("invalid", detail); }
function incomplete(detail: string): never { throw new CollectionSelectionError("incomplete", detail); }

/** Copy dense own data entries without invoking an iterator, accessor or inherited entry. */
function denseArray(value: unknown, label: string, fail: (detail: string) => never, maxLength = Number.MAX_SAFE_INTEGER): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length!.value as number;
  const keys = Reflect.ownKeys(descriptors);
  if (length > maxLength || keys.length !== length + 1 || keys.some(key => {
    if (key === "length") return false;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) return true;
    const descriptor = descriptors[key]!;
    return !descriptor.enumerable || !("value" in descriptor);
  })) fail(`${label} must contain only dense data entries`);
  const out: unknown[] = [];
  for (let i = 0; i < length; i++) out.push(descriptors[String(i)]!.value);
  return out;
}

/** Ignore unrelated adapter metadata, but snapshot every fact this selection consumes. */
function observedRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) incomplete(`${label} must be an object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor) {
      if (key in value) incomplete(`${label} must contain own data fields`);
      continue;
    }
    if (!("value" in descriptor)) incomplete(`${label} must contain data fields`);
    out[key] = descriptor.value;
  }
  return out;
}

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !keys.includes(key) ||
      !descriptors[key]?.enumerable || !("value" in descriptors[key]!))) invalid(`${label} has unsupported fields`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be plain data`);
  return value as Record<string, unknown>;
}
function locator(value: unknown, label: string): CollectionLocator {
  const row = record(value, ["role", "name"], label);
  if (typeof row.role !== "string" || !row.role.trim()) invalid(`${label}.role is required`);
  if (row.name !== undefined && (typeof row.name !== "string" || !row.name.trim())) invalid(`${label}.name must be nonempty`);
  return { role: row.role, ...(row.name !== undefined ? { name: row.name as string } : {}) };
}
function position(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${label} must be a nonnegative safe integer`);
  return value as number;
}

function attribute(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 128 || !/^data-[a-z][a-z0-9-]*$/.test(value))
    invalid(`${label} must be a bounded data-* attribute`);
  return value;
}

function boundedValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function choice(value: unknown): CollectionChoice {
  const row = record(value, ["version", "cardinality", "policy", "identity", "where", "maxReselections"], "choice");
  if (row.version !== 1 || row.cardinality !== 1 || row.policy !== "first-dom" ||
      (row.maxReselections !== 0 && row.maxReselections !== 1))
    invalid("choice requires version 1, cardinality 1, first-dom and maxReselections 0 or 1");
  const identity = record(row.identity, ["kind", "scope", "attribute"], "choice.identity");
  if (identity.kind !== "attribute" || (identity.scope !== "item" && identity.scope !== "action"))
    invalid("choice.identity requires an item or action attribute");
  const key: CollectionResourceKey = { kind: "attribute", scope: identity.scope,
    attribute: attribute(identity.attribute, "choice.identity.attribute") };
  const references = new Set<string>();
  const where = denseArray(row.where, "choice.where", invalid, 16).map((raw): CollectionChoicePredicate => {
    const predicate = record(raw, ["kind", "scope", "attribute", "value"], "choice predicate");
    if (predicate.kind !== "attribute-equals" || (predicate.scope !== "item" && predicate.scope !== "action"))
      invalid("choice supports item or action attribute-equals predicates only");
    const attr = attribute(predicate.attribute, "choice predicate attribute");
    let value: string | { bindingId: string };
    if (typeof predicate.value === "string") {
      if (!boundedValue(predicate.value)) invalid("choice predicate value must be a bounded nonblank string");
      value = predicate.value;
    } else {
      const reference = record(predicate.value, ["bindingId"], "choice binding reference");
      if (typeof reference.bindingId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(reference.bindingId))
        invalid("choice binding reference requires a bounded binding ID");
      if (predicate.scope !== key.scope || attr !== key.attribute)
        invalid("choice binding predicate must compare the declared identity attribute");
      references.add(reference.bindingId);
      value = { bindingId: reference.bindingId };
    }
    return { kind: "attribute-equals" as const, scope: predicate.scope, attribute: attr, value };
  });
  if (!where.length) invalid("choice requires at least one predicate");
  if (references.size > 1 || (references.size && row.maxReselections !== 0))
    invalid("bound choices require one binding ID and no reselection");
  return { version: 1, cardinality: 1, policy: "first-dom", identity: key, where, maxReselections: row.maxReselections };
}

/** Validate frozen input at runtime, returning a private copy before awaited browser work. */
export function validateCollectionTarget(target: Target): CollectionTarget {
  const outer = record(target, ["collection"], "target");
  const value = record(outer.collection, ["root", "itemRole", "target", "order", "index", "choice", "expectedCount", "conditions"], "collection");
  if (value.order !== "dom") invalid("only DOM order is supported");
  if (value.itemRole !== "listitem" && value.itemRole !== "option") invalid("itemRole must be listitem or option");
  const root = locator(value.root, "root");
  if (!root.name) invalid("root requires an explicit accessible name");
  if ((root.role !== "list" || value.itemRole !== "listitem") && (root.role !== "listbox" || value.itemRole !== "option"))
    invalid("root/itemRole must be list/listitem or listbox/option");
  if (("index" in value) === ("choice" in value)) invalid("collection requires exactly one of index or choice");
  const out: CollectionTarget = { root, itemRole: value.itemRole, target: locator(value.target, "target"),
    order: "dom", ...("choice" in value ? { choice: choice(value.choice) } : { index: position(value.index, "index") }) };
  if (value.expectedCount !== undefined) out.expectedCount = position(value.expectedCount, "expectedCount");
  if (value.conditions !== undefined) {
    out.conditions = denseArray(value.conditions, "conditions", invalid, 32).map((raw): CollectionCondition => {
      const condition = record(raw, ["control", "value", "checked", "disabled"], "condition");
      if (condition.value === undefined && condition.checked === undefined && condition.disabled === undefined)
        invalid("condition requires value, checked or disabled");
      if (condition.value !== undefined && typeof condition.value !== "string") invalid("condition.value must be a string");
      if (condition.checked !== undefined && typeof condition.checked !== "boolean" && condition.checked !== "mixed") invalid("condition.checked is invalid");
      if (condition.disabled !== undefined && typeof condition.disabled !== "boolean") invalid("condition.disabled must be boolean");
      return { control: locator(condition.control, "control"),
        ...(condition.value !== undefined ? { value: condition.value as string } : {}),
        ...(condition.checked !== undefined ? { checked: condition.checked as boolean | "mixed" } : {}),
        ...(condition.disabled !== undefined ? { disabled: condition.disabled as boolean } : {}) };
    });
  }
  return out;
}

/** The resolved target is transient. Persist the declaration, never these observed names/refs. */
export async function resolveCollectionTarget(driver: Driver, target: Target): Promise<{ target: Target; ref: string }> {
  const selection = validateCollectionTarget(target);
  const observeCollection = driver.observeCollection;
  if (typeof observeCollection !== "function") throw new CollectionSelectionError("unsupported", "driver does not provide collection observations");
  // Resolve run-local references privately. Even constant choices require the session to
  // authorize their source binding before the driver can observe or dispatch them.
  let expected: string[] | undefined;
  const request = structuredClone(selection);
  if (selection.choice) {
    const resolver = (driver as Driver & Partial<CollectionChoiceResolver>)[resolveChoiceValues];
    if (typeof resolver !== "function")
      throw new CollectionSelectionError("unsupported", "choice requires a selected-item evidence session");
    expected = denseArray(await resolver.call(driver, structuredClone(selection)), "choice expectations", incomplete, 16)
      .map(value => { if (!boundedValue(value)) incomplete("choice expectations are incomplete"); return value; });
    if (expected.length !== selection.choice.where.length) incomplete("choice expectations are incomplete");
    for (let i = 0; i < expected.length; i++) {
      const declared = selection.choice.where[i]!.value;
      if (typeof declared === "string" && declared !== expected[i]) incomplete("choice expectation changed a declared constant");
      request.choice!.where[i]!.value = expected[i]!;
    }
  }
  // Adapter input is separate too: a consumer cannot mutate the expectation while capturing.
  const observed = observedRecord(await observeCollection.call(driver, request),
    ["complete", "order", "items", "conditions"], "collection observation");
  if (observed.complete !== true || observed.order !== selection.order)
    throw new CollectionSelectionError("incomplete", "complete ordered membership was not established");
  const items = denseArray(observed.items, "members", incomplete).map(raw => {
    const item = observedRecord(raw, selection.choice ? ["position", "target", "disabled", "choice"]
      : ["position", "target", "disabled"], "member");
    return { position: item.position, disabled: item.disabled, target: item.target === undefined ? undefined
      : observedRecord(item.target, ["ref", "role", "name", "disabled", "occluded"], "member action"),
      choice: item.choice };
  });
  const observedConditions = denseArray(observed.conditions, "control observations", incomplete)
    .map(raw => observedRecord(raw, ["value", "checked", "disabled"], "control observation"));
  if (selection.expectedCount !== undefined && items.length !== selection.expectedCount)
    throw new CollectionSelectionError("incomplete", "member count does not match the declared total");
  const refs = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || item.position !== i || (item.disabled !== undefined && typeof item.disabled !== "boolean"))
      throw new CollectionSelectionError("incomplete", "member positions or state are incomplete");
    const ref = item.target?.ref;
    if (ref !== undefined) {
      if (typeof ref !== "string" || !ref || refs.has(ref)) throw new CollectionSelectionError("incomplete", "member references are invalid or duplicated");
      refs.add(ref);
    }
  }
  const conditions = selection.conditions ?? [];
  if (observedConditions.length !== conditions.length)
    throw new CollectionSelectionError("incomplete", "control observations are incomplete");
  for (let i = 0; i < conditions.length; i++) {
    const want = conditions[i]!;
    const got = observedConditions[i];
    if (!got || ["value", "checked", "disabled"].some(key => {
      const field = key as "value" | "checked" | "disabled";
      return want[field] !== undefined && want[field] !== got[field];
    })) throw new CollectionSelectionError("condition", "declared query/filter/sort state is not established");
  }
  let selectedIndex = selection.index;
  if (selection.choice) {
    const keys = new Set<string>();
    const eligible: number[] = [];
    for (const item of items) {
      const facts = observedRecord(item.choice, ["complete", "key", "values"], "choice facts");
      if (facts.complete !== true || !boundedValue(facts.key) || typeof item.disabled !== "boolean")
        incomplete("choice identity or eligibility is incomplete");
      if (keys.has(facts.key)) throw new CollectionSelectionError("ambiguous", "choice resource keys are duplicated");
      keys.add(facts.key);
      const values = denseArray(facts.values, "choice values", incomplete, 16);
      if (values.length !== expected!.length || values.some(value => !boundedValue(value)))
        incomplete("choice predicate observations are incomplete");
      const consumed = new Map<string, string>([[`${selection.choice.identity.scope}:${selection.choice.identity.attribute}`, facts.key]]);
      for (const [index, predicate] of selection.choice.where.entries()) {
        const attribute = `${predicate.scope}:${predicate.attribute}`, value = values[index] as string;
        if (consumed.has(attribute) && consumed.get(attribute) !== value)
          incomplete("choice observations contradict one another for the same attribute");
        consumed.set(attribute, value);
      }
      if (item.target && (typeof item.target.disabled !== "boolean" || typeof item.target.occluded !== "boolean"))
        incomplete("choice action eligibility is incomplete");
      if (item.target && (typeof item.target.ref !== "string" || !item.target.ref || typeof item.target.name !== "string"
        || item.target.role !== selection.target.role
        || (selection.target.name !== undefined && item.target.name !== selection.target.name)))
        incomplete("choice action does not match its declared scope");
      if (values.some((value, i) => value !== expected![i])) continue;
      if (item.disabled === true || item.target?.disabled === true || item.target?.occluded === true) continue;
      if (!item.target) incomplete("eligible member has no uniquely bound matching action");
      eligible.push(item.position as number);
    }
    if (!eligible.length) throw new CollectionSelectionError("missing", "no eligible member was established");
    // A bound key identifies one selected resource, never an arbitrary matching duplicate.
    if (selection.choice.where.some(predicate => typeof predicate.value !== "string") && eligible.length !== 1)
      throw new CollectionSelectionError("ambiguous", "bound choice does not identify exactly one member");
    selectedIndex = eligible[0];
  }
  const item = selectedIndex === undefined ? undefined : items[selectedIndex];
  if (!item) throw new CollectionSelectionError("missing", "requested position is absent");
  const chosen = item.target;
  if (!chosen || typeof chosen.ref !== "string" || !chosen.ref || typeof chosen.name !== "string" ||
      chosen.role !== selection.target.role || (selection.target.name !== undefined && chosen.name !== selection.target.name))
    throw new CollectionSelectionError("incomplete", "selected member has no uniquely bound matching action");
  if ((chosen.disabled !== undefined && typeof chosen.disabled !== "boolean") ||
      (chosen.occluded !== undefined && typeof chosen.occluded !== "boolean"))
    throw new CollectionSelectionError("incomplete", "selected action eligibility is invalid");
  if (item.disabled === true || chosen.disabled === true) throw new CollectionSelectionError("disabled", "requested member or action is disabled");
  if (chosen.occluded === true) throw new CollectionSelectionError("missing", "requested action is obstructed");
  return { target: { text: chosen.name, role: selection.target.role }, ref: chosen.ref };
}
