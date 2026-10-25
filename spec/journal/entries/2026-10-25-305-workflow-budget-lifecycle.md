---
issue: 305
pr: null
status: in-progress
summary: Drain complete workflow participants and preserve the first stop cause
next: Review and merge the workflow budget pull request
---

# Drain complete workflow participants

Review of the workflow owner found that draining port operations alone could return before
a concurrent borrowed call finished its owned-driver cleanup or final trace publication.
The owner now tracks the complete public call separately from its primitive operations.
Entry-local draining still waits only for primitives, avoiding a self-deadlock.

Already dispatched host work may complete during owner draining, while new admissions remain
closed. Failure from unfinished registered work rejects a successful callback value. The exact
promises returned by engine entry points and registered host operations have rejection observers,
so an abandoned sibling does not become an unhandled rejection. Failures explicitly recovered
while the workflow is open remain recoverable. Caller cancellation keeps its original reason
even when a non-cancellable operation settles after the deadline.

Validation: typecheck, build and the complete test command pass (1,614 engine tests, 397 script
and benchmark tests, eight demo tests). Package-consumer validation passes for public types,
installed CLI, browser bundling and the real Chrome quickstart. Boundaries, language and journal
checks pass. Independent review reproduced the lifecycle and cancellation cases with no
unhandled rejections.

The real-browser fixture is committed as `scripts/test-workflow-budget.mjs`. After building,
run it with Node and installed Chrome; it pins Chrome DevTools MCP 1.8.0. Preparation, discovery
and mechanical verification share three model admissions, verification uses zero model calls,
and a second host admission under a one-call allowance is refused before dispatch. All model
decisions are scripted, so the fixture needs no model account.
