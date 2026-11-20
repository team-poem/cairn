import { describe, expect, it } from "vitest";
import { captureGuidanceScope, compareGuidanceScope, copyGuidanceScope, ScopedGuidanceExpired } from "../src/core/guidance-scope.js";
import type { PageGuidanceScopeFacts, PageGuidanceScopeNode } from "../src/core/ports.js";

const target = { role: "button", name: "Checkout" };
const delivery = { role: "combobox", name: "Delivery" };
const list = { role: "group", name: "Items" };
const scope = copyGuidanceScope({ target, prerequisites: [delivery, { container: list, memberRole: "checkbox" }] });
const node = (id: string, role: string, name: string, extra: Partial<PageGuidanceScopeNode> = {}) =>
  ({ id, role, name, ...extra });
const facts = () => ({
  complete: true as const, documentId: "doc-a",
  targets: [node("t", target.role, target.name, { disabled: false, occluded: false })],
  prerequisites: [
    { members: [node("delivery", delivery.role, delivery.name, {value: "Standard", disabled: false})] },
    { containerId: "c", members: ["a", "b"].map(id => node(id, "checkbox", "Item", {checked: true, disabled: false})) },
  ],
  outside: [node("banner", "link", "Today")],
}) satisfies PageGuidanceScopeFacts;

const compare = (before: unknown, after: unknown) =>
  compareGuidanceScope(captureGuidanceScope(scope, before), captureGuidanceScope(scope, after));

describe("guidance scope declaration", () => {
  it("copies all locators and does not retain mutable declarations", () => {
    const input = { target: {...target}, prerequisites: [{container: {...list}, memberRole: "checkbox"}] };
    const copy = copyGuidanceScope(input);
    input.prerequisites[0]!.container.name = "Other";
    input.target.name = "Other";
    expect(copy.target.name).toBe(target.name);
    expect(copy.prerequisites[0]).toEqual({container: list, memberRole: "checkbox"});
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(copy.prerequisites)).toBe(true);
    expect(Object.isFrozen(copy.prerequisites[0])).toBe(true);
  });

  it.each([[], [null], [{...delivery, selector: "input"}], Array(17).fill(delivery), Array(1),
    [{container: list, memberRole: ""}], [{...delivery, container: list, memberRole: "link"}]].map(prerequisites => ({prerequisites})))(
    "rejects invalid prerequisite declarations without logging their contents: %#", ({prerequisites}) => {
      expect(() => copyGuidanceScope({target, prerequisites})).toThrow("Invalid page guidance scope");
    },
  );

  it("does not invoke getters or inherited locators", () => {
    let reads = 0;
    expect(() => copyGuidanceScope({target, get prerequisites() { reads++; return [delivery]; }})).toThrow();
    expect(() => copyGuidanceScope({target: Object.create(target), prerequisites: [delivery]})).toThrow();
    expect(reads).toBe(0);
  });
});

describe("guidance scope comparison", () => {
  it("keeps receipt errors content-free, even with extra driver fields or invalid counts", () => {
    const detail = {scopeStatus: "scope-changed" as const, addedInside: 1, removedInside: -1, changedOutside: 257, raw: "Private delivery choice"};
    const expired = new ScopedGuidanceExpired(detail);
    expect(expired.diagnostic).toEqual({scopeStatus: "scope-changed", addedInside: 1});
    expect(expired.message).toBe("page guidance expired: the declared scope changed after the guided observation");
  });

  it("ignores outside-only replacements, but reports measured counts on a scope change", () => {
    const before = facts(), after = facts();
    after.outside[0]!.id = "rotated";
    expect(compare(before, after)).toBeUndefined();
    after.prerequisites[0]!.members[0]!.value = "Private delivery value";
    expect(compare(before, after)).toEqual({scopeStatus: "scope-changed", targetUnambiguous: true,
      changedInside: 1, addedInside: 0, removedInside: 0, changedOutside: 0, addedOutside: 1, removedOutside: 1});
  });

  it("never retains Driver objects as previous evidence", () => {
    const live = facts(), before = captureGuidanceScope(scope, live);
    live.targets[0]!.occluded = true;
    expect(compareGuidanceScope(before, captureGuidanceScope(scope, live))).toMatchObject({scopeStatus: "scope-changed"});
    expect(compare(live, live)).toMatchObject({scopeStatus: "scope-unverifiable"});
  });

  it("compares the value a checkbox submits separately from its indeterminate appearance", () => {
    const before = facts(), after = facts();
    const a = before.prerequisites[1]!.members[0]!, b = after.prerequisites[1]!.members[0]!;
    a.indeterminate = b.indeterminate = true;
    b.checked = false;
    expect(compare(before, after)).toMatchObject({scopeStatus: "scope-changed", changedInside: 1});
    b.checked = true;
    b.indeterminate = false;
    expect(compare(before, after)).toMatchObject({scopeStatus: "scope-changed", changedInside: 1});
    // A driver's accessibility label alone is not evidence of the native submission state.
    Object.assign(b, {checked: "mixed", indeterminate: true});
    expect(compare(before, after)).toMatchObject({scopeStatus: "scope-unverifiable"});
  });

  it("distinguishes replacement, order, container and document changes", () => {
    const initial = facts(), next = facts(), group = next.prerequisites[1]!;
    group.members[0]!.id = "another";
    expect(compare(initial, next)).toMatchObject({scopeStatus: "scope-changed", removedInside: 1, addedInside: 1});
    group.members[0]!.id = "a";
    group.members.reverse();
    expect(compare(initial, next)).toMatchObject({scopeStatus: "scope-changed", changedInside: 2});
    group.containerId = "other container";
    expect(compare(initial, next)).toEqual({scopeStatus: "scope-changed", targetUnambiguous: true});
    expect(compare(initial, {...initial, documentId: "new document"})).toEqual({scopeStatus: "scope-changed", targetUnambiguous: true});
  });

  it("does not invent counts without comparable outside members", () => {
    const initial = facts(), next = facts();
    next.targets[0]!.disabled = true;
    for (const outside of [undefined, [next.targets[0]], Array(257).fill({})]) {
      const diag = compare(initial, {...next, outside});
      expect(diag).toMatchObject({scopeStatus: "scope-changed", changedInside: 1});
      expect(diag).not.toHaveProperty("changedOutside");
    }
  });

  it("requires consistent, disjoint container identities across set declarations", () => {
    const scope2 = copyGuidanceScope({target, prerequisites: [{container: list, memberRole: "checkbox"},
      {container: list, memberRole: "radio"}]});
    const initial = facts(), checkbox = initial.prerequisites[1]!;
    const radio = {containerId: "c", members: [node("r", "radio", "Gift", {checked: true, disabled: false})]};
    const capture = (group: typeof radio) => captureGuidanceScope(scope2, {...initial, prerequisites: [checkbox, group]});
    const valid = capture(radio);
    expect(compareGuidanceScope(valid, valid)).toBeUndefined();
    expect(compareGuidanceScope(valid, capture({...radio, containerId: "c2"}))?.scopeStatus).toBe("scope-unverifiable");
    expect(compareGuidanceScope(valid, capture({...radio, members: [{...radio.members[0]!, id: "c"}]}))?.scopeStatus).toBe("scope-unverifiable");
  });

  it("rejects incomplete prerequisites, duplicate identities, wrong roles and unknown target state", () => {
    const original = facts(), members = original.prerequisites[1]!.members;
    for (const invalid of [undefined, {...original, complete: false}, {...original, documentId: ""},
      {...original, targets: [{...original.targets[0], id: " "}]},
      {...original, targets: [{...original.targets[0], occluded: undefined}]},
      {...original, targets: [{...original.targets[0], disabled: undefined}]},
      {...original, targets: [{...original.targets[0], name: "Other button"}]},
      {...original, targets: [...original.targets, ...original.targets]},
      {...original, prerequisites: [{members: [node("delivery", delivery.role, delivery.name, {disabled: false})]}, original.prerequisites[1]]},
      {...original, prerequisites: [{members: [node("delivery", delivery.role, delivery.name, {value: "Standard"})]}, original.prerequisites[1]]},
      ...[[], [members[1], members[1]], [node("a", "checkbox", "Item")], [node("a", "button", "Item")],
        Array(257).fill(members[0])].map(ms => ({...original,
        prerequisites: [original.prerequisites[0], {containerId: "c", members: ms}]})),
      {...original, prerequisites: [original.prerequisites[0], {members}]},
      {...original, prerequisites: [original.prerequisites[0]]},
    ]) {
      expect(compare(original, invalid)?.scopeStatus).toBe("scope-unverifiable");
      expect(compare(invalid, original)?.scopeStatus).toBe("scope-unverifiable");
    }
    expect(compare(original, {...original, targets: []})).toEqual({scopeStatus: "scope-unverifiable", targetUnambiguous: false});
    expect(compare(original, {...original, targets: [...original.targets, {...original.targets[0], id: "t2"}]}))
      .toEqual({scopeStatus: "target-ambiguous", targetUnambiguous: false});
  });
});
