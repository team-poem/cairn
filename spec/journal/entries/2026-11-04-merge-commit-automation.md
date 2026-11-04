---
issue: null
pr: null
status: in-progress
summary: Align needs-merge automation with the repository merge-commit policy
next: Review and merge the fix into develop, then carry the queue setting to main
---

The repository permits merge commits but disables squash merges. The bot still
requested squash and treated GitHub's permanent 405 rejection as a transient
merge race. Runs for PRs 331 and 332 therefore completed successfully without
merging, including run 41757723867.

Use merge commits while retaining the reviewed head SHA, explicit approval and
CI checks, blocking labels, and the stacked-PR guard. Source commits keep their
authors. A disabled merge method now produces an actionable notice and fails
the run instead of promising that another unchanged evaluation will fix it.

Keep pending merge evaluations with concurrency queue max. The default branch
must receive this workflow setting; event and scheduled executions continue to
load the trusted merge implementation from develop. A retained needs-merge
request is covered through pending CI and a successful completion evaluation.

Verification: typecheck, build, all 2,092 workspace tests, 399 benchmark/script
tests and eight demo tests pass. The merge automation suite includes 100 tests.
Dependency boundaries, language and journal checks pass. The first full test
run hit the sandbox's tsx IPC restriction; the unchanged suite passed with local
IPC allowed. An independent review found no actionable defects. No live PR was
merged to test this change.
