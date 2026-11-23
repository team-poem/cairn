# Verify every target in an approved set

Use this recipe when a test must check each target in a host-approved set, such as "open A, B
and C and check each heading." A final-state assertion cannot establish that. A correct heading
on C does not show that B was checked, and three visits to A do not cover three targets.

The recipe composes existing APIs and adds no engine option:

- [Evidence checkpoints](../spec/core/evidence-capture.md) (#314) read each target's state at its
  own action boundary.
- [Predicate selection](predicate-selection.md) (#329) chooses an eligible item of one target.
- [Selected-item evidence](selected-item-evidence.md) (#327) compares the selected item's resource
  key with a key read independently from the destination.

The executable version is
[`packages/harness/test/per-target-obligations.test.ts`](../packages/harness/test/per-target-obligations.test.ts).
It runs every case below with zero model calls.

## Declare the requirements

The host owns the target scope. It is either `{ membership: "established", targets: [...] }` or
`{ membership: "unknown" }`. Reject an established scope that is empty, holds duplicates, or
exceeds 32 targets, the selected-item binding limit. Do not derive the scope from the targets a
run happened to visit.

For each target, author one choice step and two obligations:

1. A choice step that filters on the target, for example `data-target` equal to `"B"`, plus any
   eligibility attribute such as `data-available`. The target is scope; eligibility is selection
   within that target.
2. A `SelectedItemBinding` whose source and destination prefix end at that step. Persist it as a
   custom assertion and register `selectedItemEquals` for it.
3. A heading obligation persisted as custom assertion params: target label, checkpoint ID, the
   complete action prefix, and the expected heading.

Add one custom assertion that carries the scope itself. Its check passes for an established scope
and returns `{ inconclusive: true, required: true }` for unknown membership. Without it, an unknown
scope with no obligations would pass on the final assertion alone.

An obligation is identified by its target, its condition and its action prefix. The prefix fixes
both the execution boundary and the occurrence: a second visit to A has a different prefix and
still names A.

## Collect evidence on every run

Derive the runtime options from the persisted params on each run, and never store them:

- `evidenceCapture.checkpoints` gets one `{ id, after, elements: true }` entry per heading obligation.
- `selectedItemEvidence.bindings` gets every persisted binding.

The heading check calls `checkpointEvidence(evidence, { id, after })`. Checkpoint elements are a
flat snapshot, so the check scopes itself: it reads only the headings between the detail view's
region landmark and the next landmark. A heading elsewhere on the page, such as a sidebar entry
named for the target, cannot satisfy it. If no record matches, or the snapshot has no detail
region, it returns required inconclusive. Otherwise it returns whether the expected heading is
present in the detail view.
Captured records, run IDs and resource keys never enter the Scenario.

## Summarize per target

Group `verdict.results` by target, not by action. Read the target from the heading params and from
the last source step of each binding. A target is:

- `passed` when both of its obligations passed;
- `failed` when either obligation failed;
- `unconfirmed` otherwise, including a missing obligation.

Also list the targets whose selected-item obligation passed (`opened`) and whose heading obligation
passed (`heading`) separately, so one obligation never stands in for the other.

Report the target count as `"unknown"` for unknown membership. Report route progress separately,
as completed actions over scenario steps. Claim verified completion only when the verdict passed,
membership is established, and no target is failed or unconfirmed.

## Supported cases

| Case | Result |
| --- | --- |
| A, B and C each have fresh passing evidence | Verdict passes; all three targets pass. |
| A sidebar heading carries B's expected name but B's detail heading is wrong | B fails its heading obligation; `opened` still lists B, `heading` does not. |
| Only A is checked | B and C are unconfirmed; the verdict fails as `environment` although the final assertion passes. |
| B has a wrong heading and C later passes | B stays failed; the verdict fails as `flow`. |
| A is visited three times through fixed clicks | A passes; B and C checkpoints are `path-changed`, so both stay unconfirmed. |
| A is chosen three times, or the targets run in a different order | Refused with `CollectionSelectionError` before any mutation: a choice step needs a binding at its exact prefix. |
| Membership is unknown | Coverage is `unknown`; the verdict fails. |
| The final destination is reached without intermediate evidence | Every target is unconfirmed. |
| Capture is disabled, or the driver cannot read destination keys | The route completes; targets stay unconfirmed and the result is not verified. |
| Fresh replay after a state reset | Every obligation is judged again. Earlier checkpoints and bindings do not satisfy the new run. |
| The path or an obligation changes | Mismatched prefixes stay unconfirmed or are refused. Changed params change the declared contract. |
| Capture fails | Targets stay unconfirmed. No action is repeated. |
| A single-final-state scenario | Its serialized form and contract are unchanged. |

Results and summaries carry target labels, statuses and provenance IDs. They carry no raw resource
keys or DOM references.

## Limits

The initial scope is an explicit, bounded target list. Runtime enumeration of a changing or
virtualized collection is not supported. Partial results from different runs must not be combined
into full coverage. Discovery continuation for pending targets is tracked separately.
