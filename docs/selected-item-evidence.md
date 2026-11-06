# Verify the resource opened from a collection

Use selected-item evidence when a test means "open the current first result and verify that its
detail view belongs to that result." Selecting a position alone does not establish which resource
the destination represents. A fixed assertion such as "open resource A" has a different meaning
and should keep its fixed expected value.

This opt-in library API supports replay of collection `click` steps. The initial Chrome adapter
requires a same-document flow, such as a detail panel or SPA route. Full-document navigation,
discovery, explore and healing do not provide a supported binding in this version.

For explicitly choosing any eligible resource and referring to it in later actions, see
[predicate selection and safe reselection](predicate-selection.md). It reuses this binding and
does not change fixed-resource or positional intent.

## Prepare explicit resource keys

The application or test fixture must expose a nonsecret resource key in a named `data-*`
attribute. The engine does not derive one from a label, URL or DOM ref. For example, a list member
can expose `data-resource-id="B"`, while the detail view independently exposes the ID of the
resource it actually loaded. Do not copy the selected key into the destination solely to make the
test pass; that would no longer test the loaded resource.

Source keys can come from the selected member or its action node. The destination selector must
match exactly one supported light-DOM element. Missing, blank, ambiguous or oversized values leave
the relation unconfirmed. Keys are limited to 256 JavaScript string code units and compared
exactly. Two labels with the same text do not establish resource identity.

## Declare and run the relation

This example assumes a named list with two members. Each has one `Open` button; clicking it opens
a same-document detail view with heading `Details`. The detail view independently sets its own
`data-resource-id` when its resource has loaded.

```ts
import {
  runScenario,
  selectedItemEquals,
  type Scenario,
  type SelectedItemBinding,
  type Step,
} from "cairn-engine";

const steps: Step[] = [
  { kind: "goto", url: "http://localhost:4318/resources" },
  {
    kind: "click",
    target: {
      collection: {
        root: { role: "list", name: "Resources" },
        itemRole: "listitem",
        target: { role: "button", name: "Open" },
        order: "dom",
        index: 0,
        expectedCount: 2,
      },
    },
    expect: { role: "heading", text: "Details" },
  },
];

const binding = {
  version: 1,
  id: "opened-resource",
  relation: "resource-key-equals",
  phase: "replay",
  source: {
    after: steps,
    key: { kind: "attribute", scope: "item", attribute: "data-resource-id" },
  },
  destination: {
    after: steps,
    key: {
      kind: "attribute",
      selector: '[data-testid="resource-detail"]',
      attribute: "data-resource-id",
    },
  },
} satisfies SelectedItemBinding;

const scenario: Scenario = {
  name: "Open the current first resource",
  steps,
  assertions: [
    { kind: "custom", name: "opened-resource", params: binding },
    { kind: "no-console-errors" },
  ],
};

const { result } = await runScenario(scenario, {
  selectedItemEvidence: { bindings: [binding] },
  judgmentKey: "resource-key-equals-v1",
  custom: { "opened-resource": selectedItemEquals },
});

console.log(result.verdict.passed);
```

Persist the custom assertion and its declaration with the Scenario. Register the helper and
enable runtime collection each time the host runs it. Omitting collection cannot turn a required
relation into a pass. Change `judgmentKey` when the registered custom check's semantics change;
do not use it to store keys or secrets.

`source.after` names the full path ending at the selected click. The engine reads the source key
before dispatch and ties it to that actual action. `destination.after` names the boundary for the
destination read after its action and post-condition complete. It can equal the source prefix,
as above, or include later steps. No browser work belongs in `onStep`.

Use a readiness condition that represents a loaded detail view, not a heading that is already
present while loading. The engine compares the destination observed at the declared boundary;
it does not guess when the application has finished updating its identity attribute.

## Interpret the result

If A was first when the Scenario was authored but B is first on replay, the binding reads B for
that replay. Detail B passes; a valid detail C key fails. If either key or dispatch evidence is
unavailable, the helper returns required inconclusive. Another passing assertion cannot make the
overall run pass while this relation remains unconfirmed.

Each run starts with fresh evidence. Repeated selections need separate IDs and source prefixes;
the initial API allows one binding per source action and at most 32 bindings per invocation.
Edited paths require updated declarations. Existing collection behavior still refuses stale
selection and incomplete coverage instead of choosing a neighboring member. Do not combine active
bindings with `heal`, `targetChoice`, an injected step healer or a custom step-handler chain;
these combinations are rejected, including repair of steps before the selected click.

`timeoutMs` in `selectedItemEvidence` defaults to 2,000 ms for each source dispatch and destination
read. It is an acceptance deadline, not a hard browser timeout: an in-flight operation drains
before a late result is discarded. Cancellation or evidence failure does not retry the click.
A click may already have occurred when its evidence cannot be confirmed, so inconclusive does
not authorize the host to repeat a mutation.

The feature returns status, equality and run/action provenance without raw keys or DOM refs. It
does not collect full DOM, screenshots or response bodies. Independent logs and other evidence
options retain their own privacy rules.

For browser or extension hosts, use the same helper from `cairn-engine/browser` with `runHarness`
and a Driver implementing the optional selected-item capabilities. Drivers must validate the
source at dispatch, not merely read then issue an unguarded click. See the
[selected-item evidence contract](../spec/core/selected-item-evidence.md) and
[collection coverage requirements](../spec/core/collection-selection.md) before implementing one.
