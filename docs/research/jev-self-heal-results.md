# Jev pilot validation record — 2026-09-22

Initial validation base: `c8034931205de5c4403818238314cc75a8ef0bd7`; branch
`codex/jev-self-heal-pilot`. PR preparation fast-forwarded the branch to `develop` commit
`0670fa131978353871136a16797a93a681f25a7e` (Cairn 2.9.2), including #249's targeting fix.
The fixture experiments below retain their initial-base results; the code checks were rerun
on the updated base. Node 26.5.1, macOS, Google Chrome 153.0.8010.53,
Chrome DevTools MCP pinned to 1.8.0. No hosted Jev or baseline model calls, no API cost incurred.
See [design and adoption review](jev-self-heal-pilot.md).

## Code and contract verification

- Typecheck and build passed.
- Dependency boundaries, repository language, journal validation and diff whitespace passed.
- Workspace: 1,256 tests in 77 files passed on the PR base (1,250 on the initial base),
  including 46 new Jev contract/safety cases.
- Existing offline benchmark contracts: 183 passed.
- Existing real-browser/ref/layout suites: 30 passed in four files.
- Paired synthetic corpus: eight cases x two arms = 16 scripted selections; plumbing expectations
  all held. Each arm selected four targets and abstained four times. These are oracle-scripted
  outputs, not an accuracy result for either hosted model.
- Real #230 captured observation: one case x two arms = two scripted selections; mapping held in
  both. Selection-only reports leave actual repair success and false pass null.

The first unprivileged workspace test run failed two CLI process tests because the sandbox
prevented tsx's local IPC; rerunning with local IPC/server permission passed. The browser fixture
also needs localhost listening and an isolated Chrome process. This was execution permission,
not permission to spend money or contact a model provider.

## Real-browser #230 fixture experiment

All rows below used scripted Choice HTTP, the same original order-POST and destination criteria,
a fresh isolated browser and a reset server/session, with fixture document/API latency set to 0ms.
Each repair dispatched one real order and the fixture's independent oracle reported complete=true.
They are individual diagnostic runs, not independent model samples or latency percentiles.

| Driver evidence mode | Model-shaped requests | Original order assertion | Step post-condition | Confirmed repair/re-freeze |
| --- | ---: | --- | --- | --- |
| Default driver (latest page log) | 1 mock | Failed: order POST absent | Failed | Withheld |
| Preserved three-navigation window only | 1 mock | Passed | Failed: sliding-window offset | Withheld |
| Bench-only cumulative reqid log | 1 mock | Passed | Passed | Returned |
| Replay of that returned scenario, fresh browser/server | 0 | Passed | Passed | No new repair needed |

The cumulative-log repair took 5,797ms end to end; the next cold-browser replay took 4,026ms.
These include browser startup and a whole login/cart/order journey. They are **not Jev latency**.
The provider is mocked, so its request timings and usage are not meaningful cost/speed data.
Provider cache state is not applicable; no warm hosted-provider condition was measured.

MCP exposes latest-page requests by default and an optional preserved three-navigation window.
Cairn's step expectation slices the request array at a pre-step watermark, which needs append-only
ordering. Enabling preservation alone recovers the final POST assertion but does not repair the
sliding offset. The diagnostic shim caches actual wire rows by request ID; no status, assertion,
threshold, or fixture completion criterion was changed. It modifies only the benchmark's local
transport instance and uses a private method, so it must not be deployed as an engine fix.

This finding is independent of the model: a confidence of 1 did not turn missing mechanical
evidence into a pass. Service adoption needs a separately reviewed cumulative observation fix or
a consumer Driver satisfying that existing contract. The historical #230 report explicitly says
its generated freezes did not include the order POST assertion, explaining why its green runs do
not establish this stronger check on the current driver.

## Saved evidence

Generated local files (ignored by Git, reproducible with the commands in the design review):

- `bench/results/jev-pilot/default.json`: default-driver failure and full trace.
- `bench/results/jev-pilot/preserved.json`: final assertion succeeds but step still fails.
- `bench/results/jev-pilot/cumulative.json`: actual repair, unchanged assertions, next zero-call replay.
- `bench/results/jev-pilot/synthetic-contract.json`: 16 individual scripted paired selections.
- `bench/results/jev-pilot/captured-contract.json`: both arms on the captured real observation.
- `bench/results/jev-pilot/workspace-tests.log`, `bench-tests.log`, `browser-tests.log`: check output.
- `bench/results/jev-pilot/pr-tests.log`, `pr-browser-tests.log`: successful reruns on the PR base.

The preserved/cumulative diagnostic traces precede the final additive audit policy-version and
heal step-reference fields; execution and verification behavior is identical. Do not compare
fingerprints across distinct observation generations as if they were persistent element IDs.

## Not executed / decision remaining

Live TypeSafe calls, live baseline comparison, real confidence calibration, false-pass/abstention
improvement and hosted cost/latency evaluation were not run: no TypeSafe credential or approved
budget was available. Cross-application and non-English corpora, repeated cold/warm provider
trials and semantic assertions remain future work. No p50/p95, confidence threshold, claimed
cost saving or production success rate can be inferred from these small scripted runs.

Prepared selection runner and held-out labels support a later approved pilot; see the review for
required account access, separate provider budgets, metrics/denominators and adoption gates.
Rollback is removal of `targetChoice`; existing deterministic replay and legacy `heal:true` are
still available with their previous behavior. No defaults or deployed services were changed.
