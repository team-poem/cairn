# Explicit predicate selection and safe reselection (#329)

An opt-in `Target.collection.choice` chooses one eligible resource. It is exclusive with
`index`; fixed locators and positional collections retain their existing meanings. The host
authors the contract. Discovery does not infer substitution permission from missing targets.

## Initial declaration

Reuse the collection's exact root/action locators, complete DOM-order membership, declared total,
and external control conditions. `choice` requires `version: 1`, `cardinality: 1`,
`policy: "first-dom"`, an explicit `identity` data-attribute key, `where`, and
`maxReselections: 0 | 1`. Identity extraction has the same shape as a selected-item source key.

`where` contains 1–16 AND predicates of the form
`{ kind: "attribute-equals", scope: "item" | "action", attribute, value }`.
Only exact nonblank string equality is supported, with data-attribute names up to 128 characters
and values up to 256 UTF-16 code units. The engine does not implement inventory, route, price,
locale or application-specific rules. A host supplies domain facts through the Driver port;
Chrome measures the explicitly declared attributes in supported light DOM.

Every member must have complete, bounded predicate and identity facts. Unknown facts are not a
negative match and cannot justify skipping a candidate. Resource keys must be unique within the
observed collection. Among eligible, enabled, unobstructed candidates with a unique action,
choose the first in DOM order. Existing positional selection never gains this filtering behavior.
`collection.conditions` remains query/filter/sort control state, not a candidate predicate.

## Binding and dependent actions

A source choice requires an active #327 `SelectedItemBinding` for that exact action prefix.
Its source key must match `choice.identity`. Persist the binding in the custom assertion and
register `selectedItemEquals`; the selection declaration alone is not a passing assertion.

A downstream choice can use `value: { bindingId: "added-item" }` on its identity attribute.
It refers to the confirmed key from that earlier source in the same invocation. All references
in one choice must identify that same binding; downstream choices require `maxReselections: 0`.
They are supported only before the binding's declared destination boundary, including the action
at that boundary. Unavailable, expired, path-mismatched and previous-run evidence cannot resolve
the reference. A source choice cannot also be a dependent choice.

The existing selected-item session resolves references privately. Neither the persisted Scenario
nor executed steps, traces or comparison records receive the raw key. The Driver measures fresh
downstream facts, and its trusted-click receipt must confirm the same key. The final destination
still supplies its key independently, for example from a review API response rather than from
the selected DOM attribute. Changing the selection policy changes the assertion's binding params
and thus the declared judgment contract. Fixed assertions are never migrated.

## Reselection boundary

The adapter may report `SelectionNotDispatchedError` only when it knows that the exact reference
was invalidated before sending the mutation. A generic stale, timeout, transport or capture error
is not this proof. The session checks the reference, discards provisional facts, and, if explicitly
allowed, captures a fresh collection once. It then applies the original predicates and assertions.
No earlier step is replayed and no model is called. Attempt IDs belong to the existing run/action
record; only the successful attempt can supply the source key.

Once dispatch may have occurred, stop on uncertainty. No automatic retry, whole-flow restart,
rollback, or assertion replacement is permitted. An incomplete trusted-click receipt can follow
an actual click; it must not produce a passing relation or authorize another mutation. Browser
protocol calls are not an atomic application transaction, as in the existing collection contract.

Only replayed collection `click` steps in same-document flows are supported initially. Other
verbs, automatic healing, targetChoice, custom step-handler chains, discovery and full navigation
remain unsupported. Cancellation and shared execution budgets apply to each observation and
dispatch attempt. An evidence acceptance deadline also bounds whether reselection can continue.

## Verification

Test deterministic selection, fixed/positional compatibility, unsupported schemas and drivers,
missing/oversized/duplicate facts, scope boundaries and fresh observations. Test a proven
pre-dispatch invalidation followed by exactly one successful mutation, and generic or post-dispatch
failures with no retry. Dependent actions must choose only the resource from the current source;
an independently loaded contradictory review must fail. Include cancellation, budget exhaustion,
deadline expiry, path edits, repeated runs, raw-key exclusion and real Chrome/MCP fixtures.
