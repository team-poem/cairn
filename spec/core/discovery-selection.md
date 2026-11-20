# Declared selections in discovery (#343, phase 1)

A host can approve "open the current first item" before discovery runs. Without a declaration,
discovery freezes the member it clicked, so replay opens that same member or asks for repair after
the list changes. `DiscoverOptions.selections` carries the approved rule through discovery and
freeze. Replay then resolves it on each run with the existing
[collection position](collection-selection.md) and [predicate choice](predicate-selection.md)
contracts. This adds no step verb, no replay path and no model call on replay.

```ts
const scenario = await discover("Open the first post and check its detail", {
  driver, llm, baseUrl,
  selections: [{
    version: 1,
    id: "first-post",
    target: { collection: { root: { role: "list", name: "Posts" }, itemRole: "listitem",
      target: { role: "button", name: "Open" }, order: "dom", index: 0, expectedCount: 2 } },
    expect: { role: "heading", text: "Details" },
    verify: {
      source: { kind: "attribute", scope: "item", attribute: "data-post-id" },
      destination: { kind: "attribute", selector: "#post", attribute: "data-post-id" },
    },
  }],
});
```

## Declaration

- `version: 1` and a bounded `id` (letters, digits, `_ . : -`, at most 100 characters).
  IDs are unique within one call. At most 16 declarations are accepted.
- `target` is a complete `Target` with only `collection`, validated by `validateCollectionTarget`.
  It is persisted verbatim. A `choice` must use constant predicates. Binding references
  (`{ bindingId }`) need a source from the same run and are refused in discovery.
- `expect` is an optional host-approved post-condition (`url`, `text`, `role` or `requestStatus`)
  for the selection step. It must not depend on which member is selected.
- `verify` optionally declares a [#327 binding](selected-item-evidence.md): a source key on the
  selected member or action, and a destination key read after the selection step. A `choice`
  requires `verify`, because replay of a choice requires its binding.

All declarations are validated and copied before the first browser operation. An invalid shape,
a missing `Driver.observeCollection`, or a `choice` on a Driver without
`clickWithSelectedItemEvidence` throws `CollectionSelectionError` before navigation.

## Binding a declaration to one action

The system prompt and each decision prompt list the declarations not yet used. The model consumes
one with `{"action":"click","selection":"<id>"}` and no `ref`, `text`, `role`, `nth` or `value`.
The model chooses when the action happens. The engine chooses the member. A decision that names an
unknown or used ID, uses another action, or adds locator fields is not run. It is recorded as a
failure for the next decision and as a `declared-selection` gate. Each declaration is consumed by at
most one executed action. An ordinary click by ref or name never consumes a declaration. It keeps
its fixed-resource meaning, even when its element belongs to the declared collection.

The declared action runs through the replay step handler: `Driver.observeCollection`, core
coverage, conditions and position or predicate validation, then exact-ref dispatch. A `choice`
dispatches through `clickWithSelectedItemEvidence` and requires a complete key receipt. Discovery
discards that key. Policy vetting, cancellation and budget wrapping apply as for any action.

If the declared action fails at any point, discovery stops. It returns a truncated scenario with
reason `selection-failed`, holding only the steps confirmed before it and no assertions. The
application may have received the click, so no retry, neighbor or fallback click is attempted.
A discovery that finishes without consuming every declaration returns `truncated: true` with
reason `selection-unbound`. A suite does not freeze a truncated scenario.

## Freeze

The selection step persists `{ kind: "click", target: { collection } }`, with the declared
`expect` when given. It carries no `intent`, because the model's reason can name the member. Runtime
refs, observed labels and resource keys never enter the scenario, trace payloads or binding.

Evidence from the first consumed selection onward can describe the member discovery happened to
select: its URL, its API request, its page text. The freeze therefore applies these rules:

- From the first selection step onward, steps keep only host-declared expects. No expect is derived.
- `navigated` and semantic `expect` assertions are dropped.
- A `request-status` assertion is kept only when a request before the selection satisfies it.
- `no-failed-requests`, `no-console-errors` and `user` assertions are kept.
- Each dropped assertion emits a `grounding` gate with the reason.
- Each consumed selection with `verify` adds `{ kind: "custom", name: id, params: binding }`.
  The binding's source and destination prefixes are the frozen steps through that selection.

A scenario whose only proof was observed after the selection, and that declares no `verify`, fails
closed on replay as all-vacuous. This is intended: nothing frozen can show that this run's selection
reached its destination.

## Replay

Replay is unchanged. Load the scenario and run it with `runScenario`. For a frozen binding, pass the
scenario's custom binding params as `selectedItemEvidence.bindings`, register `selectedItemEquals`
under the selection ID, and supply a `judgmentKey`. Replay selects the current member and needs no
model. Selecting B and arriving at C fails the binding. Missing evidence is required inconclusive.
Rediscovery and repair stay refused for collection steps.

## Extension point for phase 2

Phase 2 (positional selection over plain links without an accessible collection root) extends this
contract without changing it. Discovery handles the declaration only through `Target` validation and
the replay step handler. A new membership form inside `Target.collection`, such as host-declared
member scope and expected count, therefore needs no change here. A destination check for full
navigation becomes a new `verify` variant. `version: 1` declarations keep their meaning.

## Verification

`test/discovery-selection.test.ts` covers positional and predicate declarations through discovery,
save/load and fresh replay with changed lists and zero model calls. It also covers a B to C
destination mismatch, freeze filtering, binding to one action, unbound and invalid declarations,
unchanged behavior without declarations, uncertain dispatch, incomplete coverage, cancellation and
budget. `npm run test:discovery-selection` runs discovery and replay against real Chrome/MCP. It
covers a reordered same-document list, a matching destination and a rejected mismatched destination.
