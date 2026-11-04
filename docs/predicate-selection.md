# Choose an eligible resource and verify the same resource

Use an explicit predicate choice when the test permits any resource satisfying declared
conditions. A fixed target still means that target; a positional collection still means its
declared position. Neither gains automatic substitution when its target disappears.

This library API supports hand-authored collection clicks in same-document replay. It compares
explicit `data-*` attributes, chooses one matching candidate in DOM order, and uses
[selected-item evidence](selected-item-evidence.md) for later identity checks. No model interprets
eligibility at runtime.

## Catalog, selection and review

Suppose catalog items expose `data-resource-id` and `data-available`. Adding one loads a cart from
its API. Cart entries expose IDs actually returned by that API, and the review view independently
exposes the reviewed ID. Do not copy the selected DOM ID into the review to manufacture a match.

```ts
import { runScenario, selectedItemEquals, type Scenario, type SelectedItemBinding, type Step } from "cairn-engine";

const identity = { kind: "attribute", scope: "item", attribute: "data-resource-id" } as const;
const steps: Step[] = [
  { kind: "goto", url: "http://localhost:4318/catalog" },
  {
    kind: "click",
    target: { collection: {
      root: { role: "list", name: "Catalog" }, itemRole: "listitem",
      target: { role: "button", name: "Add" }, order: "dom", expectedCount: 2,
      choice: {
        version: 1, cardinality: 1, policy: "first-dom", identity, maxReselections: 1,
        where: [{ kind: "attribute-equals", scope: "item", attribute: "data-available", value: "true" }],
      },
    } },
    expect: { role: "heading", text: "Cart loaded" },
  },
  {
    kind: "click",
    target: { collection: {
      root: { role: "list", name: "Cart" }, itemRole: "listitem",
      target: { role: "button", name: "Select" }, order: "dom", expectedCount: 2,
      choice: {
        version: 1, cardinality: 1, policy: "first-dom", identity, maxReselections: 0,
        where: [{ kind: "attribute-equals", scope: "item", attribute: "data-resource-id", value: { bindingId: "added-item" } }],
      },
    } },
    expect: { role: "heading", text: "Review loaded" },
  },
];
const binding: SelectedItemBinding = {
  version: 1, id: "added-item", relation: "resource-key-equals", phase: "replay",
  source: { after: steps.slice(0, 2), key: identity },
  destination: { after: steps, key: { kind: "attribute", selector: "#review", attribute: "data-resource-id" } },
};
const scenario: Scenario = {
  name: "Add an available item and review only that item",
  steps,
  assertions: [{ kind: "custom", name: "same-resource", params: binding as unknown as Record<string, unknown> }],
};
const { result } = await runScenario(scenario, {
  selectedItemEvidence: { bindings: [binding] },
  custom: { "same-resource": selectedItemEquals },
  judgmentKey: "resource-key-equals-v1",
});
```

This example assumes two catalog members and two cart members, including one pre-existing cart
item. Adjust the explicit totals to your fixture, or supply positive collection metadata. A
visible subset is not proof of completeness. Readiness conditions must identify newly loaded data,
not a heading already present before the action.

The second choice references the confirmed source of this run. It does not persist A or B as a
future expectation. A reference is supported only along the binding's declared destination path,
before that destination check completes. Updating an intermediate action requires updating the
binding too. A missing source, changed path or expired reference stops dependent selection.

## Conditions and limits

- `index` and `choice` are mutually exclusive. Existing collection control `conditions` retain
  their query/filter/sort meaning.
- Supply 1–16 exact attribute predicates; all must match. Resource keys and predicate values must
  be nonblank and at most 256 UTF-16 code units. Attribute names must be `data-*`, at most 128 characters.
- Every member needs complete facts, and resource keys must be unique in the observed collection.
  Missing facts do not mean ineligible. Unsupported coverage, ambiguous actions and unknown state
  stop selection; known disabled or obstructed candidates cannot be chosen.
- A bound predicate must compare the choice's identity attribute and use one earlier binding ID.
  Bound choices use `maxReselections: 0`; a source choice can explicitly allow one reselection.
- Bindings require a matching persisted custom assertion. Registering its check and providing
  `judgmentKey` remain the host's responsibility. Fixed-resource assertions are not rewritten.

## What reselection permits

`maxReselections: 1` permits one fresh observation only when the Driver certifies that the exact
candidate was invalidated **before sending the click**. Earlier actions are not replayed. A
transport failure, timeout, lost receipt or incomplete post-click evidence never permits retrying
the mutation. An inconclusive result can follow an actual click; do not treat it as proof that
nothing happened.

If a receipt or replacement observation exceeds the evidence acceptance deadline, the binding
keeps `status: "timed-out"` even when its destination is not reached. The comparison remains
incomplete. Cancellation and run-budget expiry also stop replacement dispatch; an observation
already in flight is allowed to settle before the run returns or rejects.

The Chrome driver revalidates consumed facts before dispatch and at the trusted-click receipt.
Separate browser protocol calls cannot make selection and application state atomic. Full
navigation, new tabs, automatic healing, targetChoice and custom step-handler chains are outside
this initial flow. Public `rediscoveryEligibility` blocks choice rediscovery with
`predicate-selection`, unless an earlier reason such as budget exhaustion applies. Rediscovery
eligibility is never permission to substitute a resource.

Custom Drivers provide complete choice facts through `observeCollection` and implement guarded
`clickWithSelectedItemEvidence`. They may throw `SelectionNotDispatchedError(ref)` only when they
can certify non-dispatch. Do not translate generic transport errors into that error. Runtime
values and browser refs do not appear in selected-item result records; independent Driver or
application logging remains the host's responsibility.

Run `npm run build && npm run test:predicate-selection` for the local API-backed Chrome/MCP fixture.
