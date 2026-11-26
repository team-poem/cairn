# Removing a declared redundant terminal click (#354)

A host may know that a button **sets** a panel to open. Clicking it twice on an
already loaded detail page has the same application effect as clicking it once.
The same claim would be false for a toggle or a quantity button. Cairn does not
infer the difference from an accessible name or from an unchanged screenshot.

## Author and replay

1. Call `discoverForReplayCleanup(intent, options)`. It returns the original
   frozen `scenario` and a separate `recording`. No click is removed from the
   discovery run, its notifications, or the saved skill. This opt-in uses the
   [action outcome](action-outcomes.md) measurements, including the driver's
   exact-node receipts. It does not enable a repeat limit unless the host also
   supplies `actionOutcomes`.
2. Finish authoring the original scenario. A host may append checks, including
   [per-target checks](../../docs/per-target-obligations.md), and stamp the final
   judgment inputs with `identifyScenario`. Approval requires a complete stamp;
   appending assertions without updating it returns `unidentified-judgment`.
   The recording does not authorize dropping or editing discovery's checks.
3. Supply a **trusted application contract** for the exact target and occurrence.
   An example for a host whose frozen button has only these two locator fields:

   ```ts
   const declaration = {
     scope: "review-panel",
     revision: "always-open-v2",
     semantics: "idempotent-click" as const,
     target: { role: "button", text: "Show summary" },
     repeatIndex: 5, // zero-based original step; the opening goto counts
   };
   const approval = await prepareReplayCleanup(scenario, recording, declaration);
   ```

   Declaring this means the **retained click is sufficient on every supported
   replay**, for all ways the frozen locator can resolve. The repeat has no
   required effect on focus, counts, requests, pending work, evidence or
   external observers, including custom checks. Only declare this if the host
   knows those semantics. The scope and revision identify the app/environment
   and conditions under which they hold. A fact about one visit is not such a
   contract. Use a new revision when those conditions change.
4. Persist the original skill; store an approved decision separately. At replay,
   obtain the **current declaration independently** from host configuration.
   Do not use a declaration copied from the saved approval as today's authority.

   ```ts
   const replayCleanup = approval.status === "approved" && currentDeclaration
     ? { approval, declaration: currentDeclaration }
     : undefined;
   const { result } = await runScenario(scenario, { driver, replayCleanup });
   ```

   `runHarness` accepts the same option. Apply the same judgment configuration
   that was stamped on the scenario, including the host's `judgmentKey` for
   custom checks. Without an option, replay uses the original path. With one,
   `result.replayCleanup` reports approval or the reason for keeping the original
   path on a completed run. Neither preparing approval nor declining it runs a
   browser, requests a model decision or retries a mutation.

## What can be removed

Only the **last step** of an adjacent pair of ordinary named clicks, with the
same frozen target and no `expect` on either click. Both dispatches must have
receipts for the same node. Before each click, Cairn compares the model's
listing with a fresh read. If the panel closed while the model was deciding,
the second click might have opened it again. Cairn keeps both clicks. For a
reference-based click the driver must support a read that preserves the pending
reference (`snapshotForTask`); a missing measurement cannot authorize cleanup.
The first click must have an observed change and the repeat must have none,
with the target and the listed controls' state covered. Both inputs and the final observation
must have the same known URL and request count, with no pending or failing
requests. A final read after assertion proposal checks for a later visible
effect. These observations can rule a candidate out; they cannot establish the
host's guarantee about future runs.

An incomplete run, an uncertain input, changed action positions from idle-scroll
pruning, a partial observation scope, or a missing measurement produces no approval.
Task plans, declared selections, guided/policy-controlled discovery and
discovery with evidence checkpoints are outside this authoring mode. So are
nonempty `secrets`: redaction can make different values look the same.
Use the normal discovery APIs for these cases. Recording alone does not change
the request interval used to freeze an action's `expect`.

## Verification on the shorter path

The approval contains fingerprints of the full source, shorter plan and removal
declaration, plus a zero-based mapping: indices through `keptThrough` are
unchanged and `removedIndex` is omitted. It contains no runtime node IDs,
resource keys or captures. Fingerprints detect incompatible inputs, not an
untrusted party forging host approval.

Removing a terminal step leaves earlier steps, their postconditions and request
watermarks in place. No expectation is transferred to a neighbor. A replay
checkpoint or selected-resource binding whose prefix includes the repeat refuses
the removal; this version does not rebind prefixes. Earlier checkpoints are
captured again under the new run ID. Assertions are never removed or rewritten.
Custom actions and checks receive their original `params` objects, so a host
can still look up those objects in a registry. If their values or references
change while approval is being checked, Cairn keeps the full path.
The execution plan gets its own fingerprint; the [judgment identity](contract-identity.md)
can stay the same because the checks did not change. A changed or incomplete
judgment identity does not qualify. A passing fixture only validates its declared
case, not arbitrary repeated clicks. If the host requests healing, target-choice
repair or environment reanchoring, `runScenario` runs the full path in the
requested mode and reports `unsupported-replay` for cleanup. No CLI is provided.

To reproduce the browser example, run `npm run build` and then
`npm run test:replay-cleanup` with Chrome installed. It serves a local page,
counts trusted clicks and checks the resulting heading after loading the saved
skill in fresh browsers. It also closes the panel while the model is deciding:
both clicks then open it and no recording is issued for approval. Workspace
tests verify three document headings and the final summary separately, including
a run with a wrong intermediate heading and one where the summary never opens.
