---
issue: 305
pr: 323
status: in-progress
summary: Keep asynchronous preparation live in the collection deadline test
next: Confirm OCI verification and review the workflow budget pull request
---

# Control the budget clock without stopping preparation

After refreshing the PR base, OCI source validation passed. Run 40437806144 then exposed
a timeout in the collection deadline test brought in from develop. The test faked every
scheduler and waited for observation to start before advancing the fake clock.

An asynchronous context provider that yields with setImmediate reproduces that circular wait:
the test times out after five seconds without reaching the observation. Limit fake timers to
setTimeout, clearTimeout, Date and performance, as the existing budget tests do. Keep the
asynchronous provider in the regression. The ten-millisecond budget and all assertions about
late-result rejection and no dispatch remain unchanged. Production behavior is unchanged.

The collection, workflow and budget tests pass together under Node 20: 132 tests.
