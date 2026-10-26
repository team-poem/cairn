# Explicit collection positions (#306)

## Meaning and authoring

`Target.collection` opts a **hand-authored or host-authored** Scenario into run-relative
position selection. It is exclusive with `text`, `role`, `index`, `nth` and `selector`.
Existing targets, model decisions and natural-language discovery keep their old meanings.
The engine does not infer whether "first result" means a saved resource or today's first item.
Use `runScenario`, the CLI replay of a saved Scenario, or browser `runHarness` with a
`StaticPlanner`. This is not a new interaction verb or a new discovery loop.

```ts
const target = {
  collection: {
    root: { role: "list", name: "Search results" },
    itemRole: "listitem",
    target: { role: "link" },
    order: "dom",
    index: 0,
    expectedCount: 3,
    conditions: [{ control: { role: "textbox", name: "Search" }, value: "books" }],
  },
};
```

Root and member-action locators are exact role/name matches, with no substring, ordinal or
CSS fallback. Root requires a name and must identify one collection. Supported declared pairs
are `list/listitem` and `listbox/option`; adapters may refuse unsupported representations.
The action locator applies **inside the selected member**, excluding nested collections.
Position is zero-based DOM source order, never CSS visual order, model ranking or prompt order.
Every member occupies a position, including disabled members and members with no matching action.
The first member lacking a usable action never authorizes the second member instead.

The collection declaration is plain persistent data, validated and copied before asynchronous
work. Unexpected fields (including temporary refs) and mixed legacy locators are rejected.
`expectedCount` is an explicit author/host assertion about the total collection size, not a hint
to truncate observations. It must match on each run. Conditions specify exact values, checked
state or disabled state of independently identified controls; these are nonsecret authoring
inputs and are **not** credential placeholders. Do not store credentials or private query values.

## Driver boundary and coverage

`Driver.observeCollection?(selection)` supplies `CollectionObservation`: a complete ordered
member array, each member's position and optional uniquely bound `PageElement` action, plus
condition observations in declaration order. It does not use the model shortlist. A missing
action is represented by a member with no `target`; filtering it out would change the contract.
Refs are private runtime handles and never persist in the Scenario.

Core validates coverage, ordering, declared total and conditions before selecting an enabled
matching action. The built-in step handler dispatches that exact ref and preserves the original
declaration in evidence/trace/frozen data. A custom Driver supporting this port promises to
revalidate collection membership/order, conditions, selected identity and eligibility before
**each** targeted dispatch, including across any asynchronous preparation. It must reject, not
re-resolve by name, when continuity is lost. Drivers without the capability fail before mutation.

The initial Chrome implementation supports named top-level light-DOM lists/listboxes and
their semantic members. Nested lists and their actions do not belong to their parent's pool.
Native listboxes (`select[multiple]` or `select` with `size > 1`) and unnamed, uniquely matched
role-only actions are included. Scoped refs do not require a legacy named locator.
It uses the existing host-owned exclusion and exact-reference machinery with an additional
collection continuity guard. Collection refs are scoped to this measured membership, not the
page-global ordinal pool: unrelated native-input shadow text need not make a proven light-DOM
collection unaddressable. Ordinary refs and their global coverage rule remain unchanged;
collection refs cannot be enriched into ordinary locators. Unsupported frame/shadow/ARIA
ownership relationships in the measured scope fail closed. Pages with framed accessibility
topology are not supported by this initial collection adapter, even for a top-level list.
Ordered membership and each matching action's owning member must agree in both the DOM and
the captured accessibility hierarchy. Incoming `aria-owns` or `ariaOwnsElements` relationships
that overlap the collection or a declared condition (including their ancestors) are refused,
even when the owner is outside the collection or belongs to excluded host UI. ID references
resolve in the owner's tree scope; unrelated and unresolved references do not poison coverage.
The owner scan includes open shadow trees and is bounded to 16,384 elements/reference entries
per measurement. Exceeding that bound refuses coverage, even on a large unrelated page.
The MCP text snapshot must also provide single-line accessible names without embedded quotation
marks. Visibly malformed quoting is refused; the raw text protocol cannot distinguish every
quote-containing name from appended attributes, so those names are outside this adapter's contract.

Positive completeness requires consistent ARIA position/total metadata or an explicit
`expectedCount`, checked against all observed members. Missing, unknown, malformed, gapped or
contradictory metadata cannot establish a complete collection. Busy, omitted or unsupported
members also refuse selection. **Absence of virtualization hints is not proof of completeness.**
An author-supplied total is trusted input; the engine cannot detect an incorrect total that
happens to equal a virtualized window. A host that knows logical collection coverage can instead
provide its own Driver facts. No implementation claims to enumerate invisible backend results.

The adapter retains exact root/member/action/control identities and revalidates them rather
than accepting a fresh same-name replacement. Reorder, replacement, removal, changed conditions
or a newly disabled action expire selection. There is no automatic retry or neighbor fallback.
Accessibility capture and its DOM measurement must share an unchanged mutation revision;
even an external label change in that window refuses dispatch. Host policy changes also expire
the binding, including registry-only changes that do not mutate the DOM.
Ownership is checked at initial capture and again at dispatch. Current property-only element
references are inspected directly rather than inferred from mutation records; this is not a
claim to detect every property change that was subsequently reverted. Browsers lacking native
element-reference reflection are tested with conservative property-input fixtures, without
claiming those fixtures change their accessibility tree. Inaccessible closed-shadow ownership
mechanisms are not supported; the AX membership check remains a separate safeguard.
As with ordinary refs, separate browser protocol calls are not an atomic application transaction;
changes after the final guard can still race. A dispatched mutation is never rolled back.

For a collection-targeted `select` step, Chrome supports native select controls only. A custom
popup needs a separate continuation contract tying its eventual option to the original member
and prerequisites. Until that is available, the adapter refuses before opening the popup;
it never commits an unchecked second click. Ordinary non-collection selects are unchanged.

## Replay, repair and evidence

Replay resolves the current position anew. If a different resource becomes first, it is selected;
the old resource's label or locator must not be added as a fallback during freeze enrichment.
`persistentTarget` retains only the validated declaration. Ordinary `nth` remains the index
among identical-name matches and is unaffected.

A collection step always executes even if its state-like `expect` already holds: a previous
destination alone does not prove selection of the current item. Its post-condition is still
checked after dispatch, and request evidence keeps the existing per-step watermark.

Locator repair and surgical step repair cannot substitute a collection step. Automatic outcome
rediscovery is disabled for a Scenario containing one, including when a later goal fails. The
host must explicitly repair/re-author the declaration; no failed positional contract is silently
relearned into a different green flow. Legacy scenarios keep their existing repair behavior.

Selection is **not** arrival or business proof. Assertions remain unchanged. If the goal requires
the destination to represent the selected resource, the host must supply a sufficient explicit
check (for example a custom criterion with appropriate run-local evidence). A generic navigation
assertion still proves only arrival; the engine does not invent a resource-identity assertion.
The judgment contract continues to exclude steps/targets and include actual assertion semantics.

Missing capability, insufficient coverage and invalid authoring/control prerequisites are
`handler` failures (environment), not application regressions. Missing/disabled targets or stale
bindings are resolution failures (script). `CollectionSelectionError.code` distinguishes these
conditions for consumers. Messages do not echo captured control values or collection contents.
Normal budget/cancellation wrapping covers observation and dispatch; no implicit model is used.

## Persistence and limits

Save a bare Scenario with the existing `saveSkillFile`/SkillStore. Loading retains its declaration;
runtime execution validates it, so an invalid collection must not become a suite cache miss that
automatically rediscovers. Automatic suite authoring/cache regeneration does not establish a
collection contract and is not the recommended authoring path for this initial API.
Older engines do not implement this opt-in field and must not be used for these new files. No
legacy fallback locators are included, reducing accidental execution by an unaware consumer.

Only DOM order and the declared semantic list types are supported. Ranking by date/price, visual
geometry, generic virtualized-page traversal and durable business-resource identity are separate
work. Runtime refs, browser registries and observations never enter saved target declarations.

## Verification

Unit regressions cover invalid schemas, exact conditions, complete ordered facts, absent and
disabled positions, duplicate refs, all existing targeted verbs, no mutation of frozen inputs,
independent replay, public browser composition and all repair gates. Browser fixtures cover
multiple/nested collections, duplicate action labels, partial coverage and pre-dispatch changes.
Run `npm run build && npm run test:collection-selection` for the browser and real Chrome/MCP fixtures;
it verifies fresh positional replay with zero model calls and refuses stale selections.
