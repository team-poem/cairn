---
issue: 267
pr: 286
status: in-progress
summary: Give no-merge precedence over automatic merge requests and report each decision
next: Review and merge PR 286 so the trusted develop script enforces the guard
---

The `no-merge` label blocks cairn-pingu even when `needs-merge` is present. The bot
checks current labels at both the initial read and the final read before its merge
API call. If GitHub truncates the label list, it refuses to merge because an unseen
label might be `no-merge`. Removing the block resumes a retained merge request;
removing `needs-merge` cancels the request.

Approval, successful current-head pull-request CI, a clean merge state, develop-only
scope, and the expected head SHA remain required despite the App's ruleset bypass.
Direct PR events read live state even when their queued label snapshot is stale.
The Actions job summary and log explain blocked, waiting, and merged outcomes.

PR 285 exposed the missing block and confusing diagnostics. Its merge evaluation
ran successfully but left the PR open while the Document references CI job failed
a 2,200 ms lower bound with a 2,199 ms measurement. The job passed on retry; the
maintainer had already removed the request label. The merge workflow exists on
main, and CI completion triggers were observed. The script is loaded from trusted
develop, so this correction becomes active when its PR lands there.

Validation: typecheck, build, workspace/benchmark/demo tests, 39 focused merge tests,
dependency boundaries, language, journal, whitespace checks, and independent review.
Live bot logs and label history were inspected; no live PR was merged as a test.
