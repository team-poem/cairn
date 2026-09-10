# 2026-09-10 — PR #227 measurement and publisher review fixes

- Branch: `codex/220-ci-performance`. User approved addressing solp721's two
  blocking findings and the failure/reporting/test gaps on PR #227.
- Sampling: extracted the collector without changing behavior, then changed
  three rounds to four (AB/BA/AB/BA). Equal first-position counts and mean
  position balance linear drift in the median; nonlinear drift and p95 noise
  remain. Each measured attempt must contain each tier exactly once.
- Data trust: PR code still produces measurements. Only same-repository PRs
  receive pingu-cairn comments; fork results remain in Actions. Both the job
  condition and the publisher enforce this policy. Authoritative PR details
  are rechecked before posting. Schema/SHA checks are not data attestation.
- Failure reporting: fully recorded failed attempts keep elapsed time. Explicit
  null usage is accepted only on failed rows, remains unknown in aggregates,
  and invalidates the tier. Successful rows with unknown usage and incomplete
  measurements still fail closed. Other complete tiers remain available.
- Presentation: keep the three tables and add one short startup/awaited-cleanup
  timing note. Clarify runner-supplied Chrome, local fresh-build prerequisites,
  the PR-owned coordinator versus baseline local runner, and p95 = max at n=4.
- Persistent validation: 42 new tests now run through `test:bench`, including
  publisher permissions/freshness/ownership, compact and mixed-effect briefing,
  scheduling/identity/incomplete guards, and an actual local-runner engine
  exception carried through worker status, collection and rendering. Earlier
  journal references to publisher mocks meant temporary `/tmp` checks; this
  change makes those checks reproducible in the repository and CI.
- Verification: 1,063 workspace plus 120 offline benchmark/publisher tests,
  typecheck, build, boundaries and actionlint pass. The first sandboxed suite
  hit tsx IPC EPERM; the same tests passed with local socket access enabled.
  Existing tests were unchanged. Independent review found no blocking issue;
  its timing-documentation correction was applied.
- Browser validation: `/tmp/cairn-227-review-comparison` contains three passing
  discoveries, six passing warmups and 24 passing measured replays, with zero
  engine-reported and observed replay LLM calls. Node 26 / Chrome 153 on macOS;
  the dirty checkout is explicit, so this validates tooling, not a performance
  claim for a clean commit. The comment preview was regenerated.
- State change: PR #227 is ready for another review with the five agreed review
  concerns addressed. Hosted CI for prior head e57d1ae passed, including Windows;
  the historical Windows failure is no longer the current CI status. The new
  head will receive fresh hosted checks. App comments still require the workflow
  and scripts on default branch main; merging only into develop does not enable
  them. No merge, release or manual review reply was performed.

## Reflection

- Brain: unchanged (root harness restrictions).
- Skills: unchanged.
- Structural: permanent CI regressions now distinguish unknown counts from zero,
  test the real measurement-to-report path, and enforce the comment data boundary.
- Todos: none added to the root vault; default-branch rollout remains documented
  in this PR's scope and must follow the maintainer's release workflow.
