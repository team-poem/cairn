---
issue: 305
pr: 323
status: in-progress
summary: Separate engine and workflow drain ownership for same-lease host wrappers
next: Review and merge the workflow budget pull request
---

# Same-lease host wrappers

Review of PR #323 found that a host operation could await an engine call using the same lease,
while the engine's drain waited for that host operation. The deadline aborted the signal but
could not break the promise cycle. Starting the engine before registering the host wrapper
produced the same cycle.

Pending operations now carry a drain owner independently of their participant accounting.
Borrowed engine calls drain engine-owned operations. The workflow owner still drains explicit
lease operations and complete engine calls, including cleanup and final publication. Driver
wrappers cache by raw driver and drain owner. Admission counts, evidence and stop attribution
remain on one participant scope.

An entry-only rejection guard would miss the reverse-order case. Rejecting host registration
during an engine call would prohibit supported managed-model callbacks. The ownership split
supports both orders without an async-context dependency or a public API change.

The public-package reproduction returned neither a result nor an error after cancellation.
Eight focused regression cases timed out before the fix. The real Chrome fixture now wraps
both discovery and frozen replay in host operations using the same lease.

Validation passes: typecheck, build, 1,624 workspace tests, 397 benchmark and script tests,
and eight demo tests. The package-consumer check covers public types, the installed CLI, browser
bundling and the real Chrome quickstart. Boundaries, language, journal and diff checks pass.
Independent review passed 72 workflow and budget tests and found no remaining defect.
The real Chrome workflow fixture completes with three discovery model calls and zero replay
model calls. Reproduce after building with `node scripts/test-workflow-budget.mjs`.
