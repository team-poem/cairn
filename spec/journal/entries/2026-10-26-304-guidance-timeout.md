---
issue: 304
pr: 322
status: in-progress
summary: Discard synchronous page guidance returned after the provider deadline
next: Review the timeout correction in PR 322 and confirm its latest CI checks
---

# Enforce provider expiry when the timer cannot run

An independent review reproduced a synchronous page-guidance provider occupying the event loop
for 5,020 ms, then returning text before the overdue timeout callback could execute. The prior
implementation accepted that late text and cleared its timer without aborting the request signal.

The provider boundary now checks monotonic elapsed time when control returns from either a
fulfilled or rejected provider call. Settlements at or after 5,000 ms expire and the provider
signal is aborted; earlier rejections remain provider failures. An already-aborted caller retains its
original reason. This is cooperative enforcement; JavaScript cannot interrupt a synchronous
callback that has not returned. Error details and guidance remain absent from new trace payloads.

Regression tests move only the monotonic clock while keeping the timer pending, for both returned
values and thrown errors: 4,999 ms preserves the provider outcome, 5,000 and 5,001 ms expire, and
simultaneous caller cancellation retains its original reason with no model dispatch. The same actual 5,020 ms reproduction now discards the result and emits the fixed
timeout diagnostic with an aborted provider signal.

Typecheck, build, dependency boundaries, language and journal checks passed. The full suite passed
1,618 workspace tests, 397 benchmark/script tests and 8 demo tests; the focused guidance suite now
contains 25 tests. Existing real Chrome/MCP guidance and zero-model replay evidence remains in
`2026-10-25-304-page-guidance-verification.md` and its committed reproducible fixture.
