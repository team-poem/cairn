---
issue: 267
pr: 287
status: in-progress
summary: Consume Octokit's normalized workflow pagination results in the merge bot
next: Merge PR 287 into develop and rerun the failed PR 285 merge evaluations
---

PR 285 had approval, the needs-merge label, and successful current-head CI, but the
merge evaluations failed while reading `head_sha`. Octokit unwraps `workflow_runs`
before invoking pagination mappers. The old mapper unwrapped it again and returned
undefined; the test fixture passed a raw REST envelope and hid this mismatch.

The bot now consumes the returned array directly. Test pages match the SDK contract
and retain coverage for latest-run selection across multiple pages, rejected heads
and events, failed CI, and all existing merge safeguards.

An offline reproduction used the exact actions/github-script v9 lockfile versions:
@actions/github 9.1.0, @octokit/core 7.0.6, paginate-rest 14.0.0 and
rest-endpoint-methods 17.0.0. Intercepted HTTP responses reproduced the original
exception and let the corrected script finish a simulated merge without remote writes.
All 1,586 workspace/benchmark/demo tests, including 41 merge tests, typecheck, build,
boundaries and language checks passed.

The clean merge-state requirement stays intact. After deployment to trusted develop,
rerun the failed evaluations to clear their stale failed checks, then reevaluate if
GitHub initially still reports UNSTABLE. Do not permit unrelated failing checks.
