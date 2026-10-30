# Selective intermediate evidence (#314)

`evidenceCapture` on `runHarness`, `runScenario` and `discover` is an opt-in **runtime capture
policy**, not a verification plan. It does not enter Scenario, its contract fingerprint, or prompts.
`onStep` remains a synchronous notification. It is not an async browser checkpoint API.

## Boundary and ownership

The engine owns and awaits reads after a completed step, before the next action. Replay captures
after `runStep` has resolved its post-condition and any surgical replacement. Discovery captures
after `applyDecision`, before the next turn's observation; discovery's freeze-time expectations have
not been assigned yet. The initial discovery `goto` also has a boundary. `settle: true` optionally
settles before reading. Settling remains a heuristic, not a verified readiness condition.

Supported phases are `replay` (default), `discover`, and outcome rediscovery `heal`. Each invocation
has its own UUID; a recovery never borrows the failed replay's captures. Explore is not supported.
Internal locator attempts and the original failed surgical action are not separate checkpoints:
the completed step boundary names the replacement returned by the healer. A locator recipe is not
proof of the exact selected DOM node or business resource (#327).

Each selection supplies a unique `id`, a complete `after` action prefix, and explicitly selected
`elements` and/or `screenshot`. Matching uses action parameters, ignoring `intent` and `expect`
metadata. Repeated actions have different prefix lengths and occurrence IDs. Changed prefixes,
including healed replacements, require explicit rebinding. Discovery may prune idle scrolls or
enrich locators when freezing: author the verification plan against the resulting frozen path,
not a copied notification index. Captures are never verification bindings for future runs.

Binding prefixes require finite, plain, acyclic JSON data (no Date, Map, functions, accessors,
sparse arrays, undefined custom parameters or negative zero). Unsupported declared prefixes are
rejected before dispatch. Unsupported runtime action data invalidates pending captures as
`unavailable / unsupported-path` without rejecting or retrying the action. Once all selected
boundaries are accounted for, capture stops inspecting later action parameters.

A skipped or failed step invalidates the prefix: its checkpoint and later checkpoints cannot
silently prove execution of that path. A discovery failure that cannot return an executed Step
also invalidates the remaining prefix, conservatively. Unreached selections produce `skipped /
not-reached` notifications. Cancellation produces `cancelled`; the public call still rejects.
An interrupted dispatch without a returned Step does not invent an executed action identity.

## Bounded reads and data

The default acceptance deadline is 2,000 ms per selected boundary, including optional settling.
At most 100 selections are accepted per invocation. Snapshots over 10,000 rows or records over
10,000,000 JSON characters are unavailable. Reads at a shared boundary are reused, including the
existing all-step screenshot when enabled. No new operation starts after deadline/cancellation.
Late results are discarded. An in-flight driver call is **drained, never raced and abandoned**,
matching `run-budget.md`; a driver that never settles can still block the call. This is not a hard
browser-operation timeout. Capture failure never retries the mutation. Workflow/run budgets
include capture reads and can terminate the whole run independently of the capture deadline.

Records distinguish `captured`, `unavailable`, `timed-out`, `cancelled`, and `skipped`, and report
`elapsedMs` separately. Only complete accepted reads retain data. `complete` means all requested
reads finished, NOT full DOM coverage. Elements are the driver's accessibility snapshot, not a DOM
archive; references and geometry are excluded. Document identity is explicitly `unknown`; screenshot
and snapshot are sequential, not an atomic browser transaction. These captures cannot establish
same-document identity, offscreen absence, or that a condition held continuously throughout a run.

Values are excluded by default (`includeValues` opts in). Known supplied secret strings in textual
fields are slotted; this is not general PII detection. Screenshot pixels are **never automatically
redacted**. Capture them only with explicit consent and appropriate test data. No checkpoint bytes
are automatically attached to traces. The host owns retention and external storage.
Only the top-level screenshot bytes have that exception: a custom parameter named `screenshot`
is still textual data and is redacted. Engine IDs, enums and fingerprints are not text payloads
and are never rewritten by secret substitution. Display paths are redacted; a SHA-256 fingerprint
of the validated original action prefix supplies the binding independently of display data.
Fingerprints are identifiers, not encryption for low-entropy private values; prefer secret slots
in persistent action data and apply the same access controls as to other judgment fingerprints.

Replay returns `evidence.checkpoints` with `captureRunId`. Discovery delivers records through the
optional synchronous `onCapture` observer; observer failures cannot retry actions. Do not drive
the browser from observers. A copy is delivered; edits cannot change internal evidence. On budget
exhaustion or cancellation, use this notification for diagnostics; normal successful-result evidence
is not promised by those terminal outcomes. Previously returned Driver checkpoint fields are stripped.

## Verification is a separate contract

Use a persisted custom assertion with checkpoint ID and expected action prefix in its `params`,
plus an explicit `judgmentKey` for the check implementation. Runtime selection may collect more or
less data without changing the judgment contract. Adding/removing/rebinding a required checkpoint
changes the assertion params (and contract); changing capture policy alone must not make it pass.

`await checkpointEvidence(evidence, { id, after, phase? })` resolves only one current-run, complete,
successful, non-skipped capture matching the declared path. A custom check must additionally require
the specific fields and coverage it needs. Missing/insufficient data returns
`{ inconclusive: true, required: true, detail }`. A contradictory observed value returns false.
Required inconclusive checks prevent green even when final-page checks pass; optional inconclusive
checks retain #248 semantics. A missing required check alone is an environment failure (unconfirmed,
not an application regression). A real app failure still takes precedence. Required status is part
of trace assertion payloads (1.14), but captures themselves are not trace payloads.
Built-in judgment revision is 2: the new required-inconclusive aggregation must not compare as
the same judgment contract as revision 1, which ignored that requirement.

## Reproduction

Unit tests: `npx vitest run test/evidence-capture.test.ts` from `packages/harness`.
Real Chrome/MCP: build, then `node scripts/test-evidence-capture.mjs`. This uses a local
editor-review-confirmation fixture and proves positive, wrong heading, disabled save and missing
capture cases while final confirmation passes, with zero model calls. No production app access.
