# 2026-09-10 — PR #227 comment tail statistics and independent gate tests

- Branch: `codex/220-ci-performance`. User approved the second review response:
  omit p95 from the PR comment, retain artifact statistics, disclose residual
  order bias briefly, and strengthen independently effective fork-gate tests.
- Presentation: `renderComparison` has an independent `includeP95` option that
  defaults to true. Only the publisher disables it. All three comment tables,
  medians, deltas and failure/usage statuses remain. Full reports retain p95 and
  explain that at four samples it is the maximum and sensitive to order. The
  visible timing note retains startup/awaited cleanup and adds residual order
  bias. No fixed percentage is claimed for that bias.
- Validation: six new tests in `bench/ci-comment.test.mjs` run through the existing
  CI glob. The job condition is evaluated independently of the publisher. Runtime
  tests use separate association, first-read and final-read PR snapshots and
  assert the call boundary at which the request is rejected.
- Mutation evidence: removing the job repository condition, early run repository
  guard, first PR repository guard and final PR repository guard individually in
  temporary copies each causes its test to fail. Re-enabling comment p95 also
  causes the presentation test to fail. Results are recorded locally at
  `/tmp/cairn-227-second-mutations.json`; regression tests themselves are committed.
- Verification: 1,063 workspace + 126 benchmark/publisher tests pass (1,189 total),
  with typecheck, build, actionlint and whitespace checks passing. Independent
  review ran 33 focused tests and found no blocking issue. Existing tests are
  byte-identical to the prior head. The preview was regenerated from the earlier
  real 24-replay dataset; collection code was unchanged and was not rerun.
- State change: PR #227 addresses the remaining p95 presentation concern and the
  nonblocking gate-test/order-disclosure notes. Default-branch publisher rollout
  is still required; no merge, release or manual review response was performed.

## Reflection

- Brain: no persistent changes (root harness restrictions). A scratch-plan append
  initially used the workspace cwd; it was immediately moved to the app's local
  plan and the root checkout was verified clean.
- Skills: unchanged.
- Structural: mutation-checked regressions now distinguish each guard's own
  boundary from protection accidentally provided by a downstream check.
- Todos: none added to the root vault.
