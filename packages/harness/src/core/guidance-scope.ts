/** A host-declared scope for one exact, reference-free click. These are not replay locators. */
export interface PageGuidanceLocator { readonly role: string; readonly name: string }
export interface PageGuidanceSet { readonly container: PageGuidanceLocator; readonly memberRole: string }
export interface PageGuidanceScope {
  readonly target: PageGuidanceLocator;
  readonly prerequisites: readonly (PageGuidanceLocator | PageGuidanceSet)[];
}

/** IDs identify actual nodes for the document's lifetime. A replacement needs a different ID
 * even when role and name are identical. Include all applicable state; omit facts entirely
 * if the driver cannot measure a relevant state or cannot represent the control. Supply
 * disabled for in-scope controls, checked for checkable roles and value for value-bearing
 * controls. For native checkboxes include the submission value, underlying checked bit and
 * indeterminate state independently; an AX "mixed" value alone does not establish them.
 * For a target, occluded:false requires a visible, actionable hit, not just
 * absence of an overlay. */
export interface PageGuidanceScopeNode extends PageGuidanceLocator {
  readonly id: string;
  readonly value?: string;
  readonly checked?: boolean;
  readonly indeterminate?: boolean;
  readonly disabled?: boolean;
  readonly occluded?: boolean;
  readonly inActivePopup?: boolean;
  readonly clickable?: boolean;
}
/** Only assert completeness when the facts and listing describe the same observation and
 * matches are exhaustive. Container IDs identify uniquely resolved containers. Set members
 * are in document order; no truncation, visible-window substitution or name-based identity. */
export interface PageGuidanceScopeFacts {
  readonly complete: true;
  readonly documentId: string;
  readonly targets: readonly PageGuidanceScopeNode[];
  /** Optional complete complement within the observed listing, in source order and using
   * the same ID namespace. Exclude the target, containers and all prerequisite members.
   * Do not add a capture for this diagnostic. Omission means unavailable, not empty. */
  readonly outside?: readonly PageGuidanceScopeNode[];
  readonly prerequisites: readonly {
    readonly containerId?: string;
    readonly members: readonly PageGuidanceScopeNode[];
  }[];
}

export interface GuidanceScopeDiagnostic {
  scopeStatus: "scope-changed" | "target-ambiguous" | "scope-unverifiable";
  targetUnambiguous?: boolean;
  addedInside?: number;
  removedInside?: number;
  changedInside?: number;
  addedOutside?: number;
  removedOutside?: number;
  changedOutside?: number;
}

const MAX_GROUPS = 16;
const MAX_NODES = 256;

/** A driver may detect expiration after the final capture but before dispatch. Copy only
 * known status/count fields: neither its exception message nor the supplied object is trace data. */
export class ScopedGuidanceExpired extends Error {
  readonly diagnostic: GuidanceScopeDiagnostic;
  constructor(diagnostic: GuidanceScopeDiagnostic) {
    const status = diagnostic.scopeStatus === "scope-changed" || diagnostic.scopeStatus === "target-ambiguous"
      ? diagnostic.scopeStatus : "scope-unverifiable";
    const reason = {
      "scope-changed": "page guidance expired: the declared scope changed after the guided observation",
      "target-ambiguous": "page guidance expired: the declared target matched more than once",
      "scope-unverifiable": "page guidance expired: the declared scope could not be validated",
    }[status];
    super(reason);
    this.name = "ScopedGuidanceExpired";
    const safe: GuidanceScopeDiagnostic = {scopeStatus: status};
    if (typeof diagnostic.targetUnambiguous === "boolean") safe.targetUnambiguous = diagnostic.targetUnambiguous;
    for (const key of ["addedInside", "removedInside", "changedInside", "addedOutside", "removedOutside", "changedOutside"] as const) {
      const count = diagnostic[key];
      if (typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= MAX_NODES) safe[key] = count;
    }
    this.diagnostic = Object.freeze(safe);
  }
}
function invalid(): never { throw new TypeError("Invalid page guidance scope"); }

// Copy only own data properties. Do not invoke adapter or author-supplied getters.
function record(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const proto = Object.getPrototypeOf(input);
  if (proto !== null && proto !== Object.prototype) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !fields.includes(key)) invalid();
    const desc = Object.getOwnPropertyDescriptor(input, key);
    if (!desc || !desc.enumerable || !("value" in desc)) invalid();
    result[key] = desc.value;
  }
  return result;
}
function array(input: unknown, max: number): unknown[] {
  if (!Array.isArray(input) || input.length > max) invalid();
  const values: unknown[] = [];
  for (let i = 0; i < input.length; i++) {
    const entry = Object.getOwnPropertyDescriptor(input, i);
    if (!entry || !("value" in entry)) invalid();
    values.push(entry.value);
  }
  return values;
}
function str(v: unknown, max: number, empty = false): string {
  if (typeof v !== "string" || v.length > max || (!empty && !v.trim())) invalid();
  return v;
}
function locator(input: unknown): PageGuidanceLocator {
  const {role, name} = record(input, ["role", "name"]);
  return Object.freeze({role: str(role, 64), name: str(name, 512)});
}
export function copyGuidanceScope(input: unknown): PageGuidanceScope {
  try {
    const r = record(input, ["target", "prerequisites"]);
    const target = locator(r.target);
    const prerequisites = array(r.prerequisites, MAX_GROUPS).map(p => {
      const obj = record(p, ["role", "name", "container", "memberRole"]);
      if (!("container" in obj)) return locator(obj);
      if ("role" in obj || "name" in obj) invalid();
      return Object.freeze({container: locator(obj.container), memberRole: str(obj.memberRole, 64)});
    });
    if (!prerequisites.length) invalid();
    return Object.freeze({target, prerequisites: Object.freeze(prerequisites)});
  } catch { return invalid(); }
}

type MeasuredNode = { id: string; state: string; };
type Group = { containerId?: string; nodes: MeasuredNode[] };
export type CapturedGuidanceScope =
  | { error: GuidanceScopeDiagnostic }
  | { documentId: string; groups: Group[]; blocked: boolean; outside?: MeasuredNode[] };

function unavailable(targetUnambiguous?: boolean): { error: GuidanceScopeDiagnostic } {
  return {error: {scopeStatus: "scope-unverifiable", ...(targetUnambiguous !== undefined && {targetUnambiguous})}};
}

/** Snapshot before calling the provider. Only these private copies participate in comparison;
 * observations and IDs never become part of a diagnostic or a saved step. */
export function captureGuidanceScope(scope: PageGuidanceScope, facts: unknown): CapturedGuidanceScope {
  let targetUnambiguous: boolean | undefined;
  try {
    const r = record(facts, ["complete", "documentId", "targets", "prerequisites", "outside"]);
    if (r.complete !== true) return unavailable();
    const documentId = str(r.documentId, 256);
    const targets = array(r.targets, MAX_NODES);
    if (!targets.length) return unavailable(false);
    let blocked = false;
    const seen = new Set<string>();
    function measure(input: unknown, role?: string, name?: string, target = false): MeasuredNode {
      const n = record(input, ["id", "role", "name", "value", "checked", "indeterminate", "disabled", "occluded", "inActivePopup", "clickable"]);
      const id = str(n.id, 256);
      if (seen.has(id)) invalid();
      seen.add(id);
      const observedRole = str(n.role, 64);
      if (role !== undefined && observedRole !== role || name !== undefined && n.name !== name) invalid();
      const observedName = str(n.name, 512, true);
      if (target) targetUnambiguous = true;
      if (n.value !== undefined) str(n.value, 4096, true);
      for (const field of ["checked", "indeterminate", "disabled", "occluded", "inActivePopup", "clickable"]) {
        if (n[field] !== undefined && typeof n[field] !== "boolean") invalid();
      }
      if (["checkbox", "radio", "switch"].includes(observedRole) && n.checked === undefined) invalid();
      if (["combobox", "textbox", "searchbox", "slider", "spinbutton"].includes(observedRole) && n.value === undefined) invalid();
      if (role !== undefined && ["button", "checkbox", "radio", "switch", "combobox", "textbox", "searchbox", "slider", "spinbutton"].includes(observedRole)
          && typeof n.disabled !== "boolean") invalid();
      if (target) {
        if (typeof n.disabled !== "boolean" || typeof n.occluded !== "boolean") invalid();
        blocked = n.disabled || n.occluded;
      }
      const state = JSON.stringify([observedRole, observedName, n.value, n.checked, n.indeterminate, n.disabled, n.occluded, n.inActivePopup, n.clickable]);
      return {id, state};
    }
    if (targets.length > 1) {
      // Duplicate rows for the same node, or rows not matching the declaration, cannot
      // establish actual ambiguity. A well-formed second matching target can.
      for (const n of targets) measure(n, scope.target.role, scope.target.name);
      return {error: {scopeStatus: "target-ambiguous", targetUnambiguous: false}};
    }
    const groups: Group[] = [{nodes: [measure(targets[0], scope.target.role, scope.target.name, true)]}];
    const ps = array(r.prerequisites, MAX_GROUPS);
    if (ps.length !== scope.prerequisites.length) invalid();
    const containerByLocator = new Map<string, string>();
    const locatorByContainer = new Map<string, string>();
    for (const [i, p] of scope.prerequisites.entries()) {
      const g = record(ps[i], ["containerId", "members"]);
      const members = array(g.members, MAX_NODES - seen.size);
      if (!members.length) invalid();
      if ("container" in p) {
        const containerId = str(g.containerId, 256);
        const key = JSON.stringify([p.container.role, p.container.name]);
        if (containerByLocator.has(key) && containerByLocator.get(key) !== containerId ||
            locatorByContainer.has(containerId) && locatorByContainer.get(containerId) !== key) invalid();
        containerByLocator.set(key, containerId);
        locatorByContainer.set(containerId, key);
        groups.push({containerId, nodes: members.map(n => measure(n, p.memberRole))});
      } else {
        if (members.length !== 1 || g.containerId !== undefined) invalid();
        groups.push({nodes: [measure(members[0], p.role, p.name)]});
      }
    }
    // A listed member cannot be its own container. Overlapping declarations are unsupported.
    for (const id of locatorByContainer.keys()) {
      if (seen.has(id)) invalid();
      seen.add(id);
    }
    let outside: MeasuredNode[] | undefined;
    if (r.outside !== undefined) {
      // An incomplete or unmatchable outside measurement supplies no diagnostic counts.
      // It cannot authorize a comparison of incomplete inside facts.
      try { outside = array(r.outside, MAX_NODES).map(n => measure(n)); } catch { /* unavailable */ }
    }
    return {documentId, groups, blocked, outside};
  } catch { return unavailable(targetUnambiguous); }
}

/** Counts apply to disjoint matched nodes only. Values from different documents or
 * replaced containers have no reliable correspondence; omit counts rather than guessing. */
function nodeChanges(before: MeasuredNode[], after: MeasuredNode[]) {
  const prior = new Map(before.map((n, idx) => [n.id, {state: n.state, idx}]));
  let added = 0, changed = 0;
  for (const [idx, node] of after.entries()) {
    const old = prior.get(node.id);
    if (!old) added++;
    else {
      if (old.idx !== idx || old.state !== node.state) changed++;
      prior.delete(node.id);
    }
  }
  return {added, changed, removed: prior.size};
}

export function compareGuidanceScope(before: CapturedGuidanceScope, after: CapturedGuidanceScope): GuidanceScopeDiagnostic | undefined {
  if ("error" in after) return after.error;
  if ("error" in before) return before.error;
  const changed = {scopeStatus: "scope-changed", targetUnambiguous: true} as const;
  if (before.documentId !== after.documentId || before.groups.length !== after.groups.length) return changed;
  let addedInside = 0, removedInside = 0, changedInside = 0;
  for (const [i, group] of before.groups.entries()) {
    const fresh = after.groups[i]!;
    if (group.containerId !== fresh.containerId) return changed;
    const counts = nodeChanges(group.nodes, fresh.nodes);
    addedInside += counts.added;
    changedInside += counts.changed;
    removedInside += counts.removed;
  }
  if (addedInside || removedInside || changedInside) {
    const outside = before.outside && after.outside && nodeChanges(before.outside, after.outside);
    return {...changed, addedInside, removedInside, changedInside, ...(outside && {
      addedOutside: outside.added, removedOutside: outside.removed, changedOutside: outside.changed,
    })};
  }
  if (before.blocked || after.blocked) return unavailable(true).error;
  return undefined;
}
