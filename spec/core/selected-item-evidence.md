# Run-local selected-item evidence (#327)

Selecting the current first member of a collection and verifying the resource opened by that
selection are separate contracts. `Target.collection` supplies the former. An opt-in
`SelectedItemBinding` declares equality between a resource key read from the selected member before
its click and a key read independently from the destination.

The initial API supports hand-authored replay of collection `click` steps. It does not infer
business identity from labels, temporary refs, URL shapes or position. Fixed-resource assertions
keep their existing meaning. [Predicate selection](predicate-selection.md) reuses this session for
explicit choices and dependent actions, with bounded, proven pre-dispatch reselection only.

## Declaration and judgment

Persist the binding in a custom assertion's `params` and register `selectedItemEquals` under its
name. The runtime option `selectedItemEvidence: { bindings, timeoutMs? }` enables collection;
runtime settings alone do not add an assertion or define what must pass. The
[consumer example](../../docs/selected-item-evidence.md) shows both parts.

`SelectedItemBinding` contains `version: 1`, a unique `id`, `relation: "resource-key-equals"`,
`phase: "replay"`, and the following declarations:

- `source.after`: the complete action prefix ending in the collection click. This identifies the
  occurrence; the source key is read **before** that click, not at the after-step boundary.
- `source.key`: `{ kind: "attribute", scope: "item" | "action", attribute }`. The scope selects
  either the chosen collection member or its exact action node.
- `destination.after`: the complete prefix at which to read the destination. It must extend or
  equal the source prefix.
- `destination.key`: `{ kind: "attribute", selector, attribute }`. The selector must identify
  exactly one node in the supported document; it is not inferred from the source key.

Action matching follows intermediate checkpoint rules: `intent` and `expect` metadata do not
define action identity. Repeated identical clicks have different prefixes. Declarations must be
plain, finite, acyclic JSON. Prefixes have at most 1,000 steps; IDs have at most 100 characters and
use letters, digits, `_`, `.`, `:`, or `-`, starting with a letter or digit. Attribute names have
at most 128 characters and match `data-[a-z][a-z0-9-]*`. Destination selectors have at most 512
characters. Values must be nonblank strings of at most 256 JavaScript string code units; comparison
is exact, with no trimming, case folding or coercion. Missing or ambiguous values cannot match.

The check requires one current-run record with the exact declaration fingerprint and both expected
action occurrence IDs. A different runtime extraction declaration cannot satisfy the assertion.
Existing custom-assertion identity rules apply: params enter the judgment contract, and the host
supplies a `judgmentKey` for its registered check semantics. A changed relation or extraction
changes the contract. Observed keys and refs never enter Scenario. Historical contracts are not
rewritten; required inconclusive aggregation continues to use judgment revision 2.

## Execution ownership

Each invocation owns a fresh session and validates/copies its bindings before execution. At most
32 bindings and one binding per source occurrence are accepted. Unsupported phases and source
actions are rejected rather than silently treated as ordinary evidence.

Core resolves the collection through `Driver.observeCollection`, then supplies the exact selected
ref to optional `Driver.clickWithSelectedItemEvidence(target, ref, sourceKey)`. This method owns
the source read, continuity checks and trusted click. A complete `ResourceKeyObservation` must
attest to the key on the selected item/action at that dispatch. A read followed by an unguarded
ordinary click does not implement this port. A DOM ref alone is not a resource key.

The source read remains provisional until the action completes and the engine accepts its result.
Failed, skipped or interrupted execution cannot become successful source evidence. If the Driver
lacks the combined capability, the original click can still run once, but the binding remains
unavailable. If the combined operation throws, the engine never falls back to an ordinary click:
the application may already have received the action.

Predicate choices require the combined capability and a persisted binding assertion before
execution. Only `SelectionNotDispatchedError` carrying the exact reference permits their explicitly
bounded reselection; positional bindings never retry. `selectionAttempts` records the run/action
attempt IDs and whether dispatch was refused, completed or uncertain. Only the successful source
attempt supplies the key. Dependent choices resolve that key privately along the declared path
before its destination boundary; no second identity store or extended key lifetime is introduced.

The destination uses optional `Driver.readResourceKey(destinationKey)` at the existing awaited
after-step boundary, after post-condition handling and before the next action. It does not use an
asynchronous `onStep` callback or a second checkpoint scheduler. When both prefixes are equal,
source and destination remain independent reads on opposite sides of the click.

Evidence belongs to the run, replay phase and actual action occurrences. Failed or changed
prefixes leave pending bindings unconfirmed. A new replay never reuses a prior key or driver record.
Active bindings cannot be combined with `runScenario`'s `heal` or `targetChoice`, or with an
injected `runHarness` step healer. This also excludes repairs of earlier ordinary steps whose
changed path would otherwise precede the selected click. Custom step-handler chains are not
supported. Discovery, explore and healed paths are not supported binding phases in this version;
the host must author a new declaration for another path.

## Results, deadlines and data

`selectedItemEquals` passes only for complete current-run evidence with equal keys. Two valid but
unequal keys fail. Missing, incomplete, stale, unsupported, cancelled or unreached evidence returns
required inconclusive, so another passing assertion cannot cover the missing relation. An
incomplete read is not evidence that the application opened the wrong resource.

The default acceptance deadline is 2,000 ms, separately for source dispatch and destination read.
Late results are discarded after an in-flight operation drains; this is not a hard browser timeout.
Run budgets and cancellation still apply. Evidence failure never authorizes another click,
retries a mutation or selects a neighboring member.

An observed capture timeout or cancellation remains in the binding's status even when the
failed action prevents reaching its destination. Its comparison stays incomplete and carries
no equality result. A capture timeout belongs only to its binding; other unreached bindings
remain skipped unless the run is cancelled. A transport error is not relabeled as a capture
timeout merely because it arrived late.

The session compares bounded raw values before diagnostic redaction. Public records carry an ID,
declaration fingerprint, run/phase and action occurrence IDs, status, completeness and equality,
not raw keys, DOM refs or copied action paths. `Evidence.selectedItems` and
`Evidence.selectedItemRunId` hold only the current invocation's records. No whole-page DOM,
credential values, response bodies or screenshots are collected by this feature, and it adds no
trace attachment bytes. Consumers still own the meaning and sensitivity of their declared
attributes and any separate logging they enable.

## Initial Chrome adapter limits

All existing collection coverage and continuity restrictions apply. Chrome supports same-document
collection clicks and an independently selected destination in supported light DOM. The bounded
destination scan visits at most 16,384 elements and excludes registered host-owned content.

A StaticText backend reference can resolve to a Text node or its parent Element. For a Text
node, attribute and disabled-state reads use its parent Element, as collection measurement does.
The receipt retains both identities and checks the trusted event against that Element. Replacing
or reparenting the Text node cannot bind the receipt to a different action.

The adapter verifies a trusted-click receipt as well as the source key. A lost receipt, including
full-document navigation that discards it, leaves the relation unconfirmed. Navigation alone must
not become successful resource evidence. The source observation and event are not an atomic
application transaction. If continuity is lost, the adapter must not report complete evidence;
the application may already have received the click before an incomplete receipt is detected.
There is no rollback or automatic retry.

The event check also refuses a newly attached open shadow root in the collection and an incoming
`aria-owns` relation that was subsequently removed when its old targets remain identifiable.
Unrelated shadow trees and unrelated or unresolved ARIA references do not invalidate the binding.
The driver records the pre-click tab set, including when attached without an initial `goto`.
Receipt reads and cleanup finish before the engine follows a newly opened tab; a new tab (even an
initializing blank tab) or unknown page observation leaves the relation unconfirmed. A `pagehide`
listener clears the source
document's receipt on full navigation, including entry into the back/forward cache. Normal completion
and read/dispatch errors remove the click and pagehide listeners without repeating the action.

Equality proves that the declared observed keys match. It does not prove application-wide key
uniqueness, unrelated business outcomes, or continuous validity throughout a run. Duplicate labels
do not help this relation, and labels alone never supply its resource identity.

## Verification scope

Tests must distinguish current-item equality from fixed-resource verification, reject stale or
missing evidence, and keep repeated occurrences separate. They must cover changed source keys,
interrupted reads, changed prefixes, fresh runs, bounded extraction and the absence of raw keys
from exports. Real Chrome/MCP fixtures should exercise a changed first item and destinations with
both matching and contradictory keys. These checks are mechanical and do not request a model.

`npm run build && npm run test:selected-item-evidence` runs a local fixture that fetches detail
records from a separate HTTP API. It covers current A/B, a B request returning C, missing/stale
evidence, late shadow/ARIA changes, full navigation, popup cleanup and capture disabled. The server
must record one detail request per click; engine evidence must also contain that request except
for an unsupported popup, whose initial traffic may precede protocol capture. The first positive case uses
the default capture deadline; the remaining cases allow extra time for protocol/CI load.
