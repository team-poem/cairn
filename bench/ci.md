# Pull-request benchmarks and OS compatibility

Every PR runs `PR benchmarks`, comparing its exact base and head SHAs on one
Ubuntu runner. The Actions summary and `cairn-benchmarks-<run_attempt>` artifact contain the
comparison and its raw data, including for fork PRs. A separate workflow updates
one pingu-cairn comment for same-repository PRs only. Fork measurement artifacts
are produced by contributor-controlled code and must not receive a repo-App
endorsement. Their results remain in Actions. The publisher runs trusted
default-branch code, reads JSON only, recomputes the comparison, and skips
outdated base/head results. Same-repository contributors are inside this data
trust boundary; schema and SHA checks do not authenticate measurement truth.
Artifacts are scoped to the exact rerun attempt, so an early failure cannot
reuse an earlier attempt's successful measurements.

The comment starts with a short briefing: package and browser-gzip changes,
observed replay-median changes by tier, passed attempts and LLM call counts.
Expand **Detailed measurements** for the three comparison tables. Extended
interpretation notes, environment details and hashes remain in the downloadable
report and raw artifacts, rather than the PR comment. Invalid
tiers carry no speed claim. A short timing note always states that server/browser
startup and awaited cleanup are included and residual order bias may remain;
timing remains informational. The comment omits p95: with four samples it is
the maximum, and the extreme measurement slots are not balanced. The full report
in Actions and the artifacts retains p95 with its sample-size/order caveat.

The publisher reuses `CAIRN_BOT_CLIENT_ID` and `CAIRN_BOT_PRIVATE_KEY` for the
pingu-cairn GitHub App already used by repository automation. Its installation
token requests only pull-request write permission; artifact reads keep using the
read-only workflow token. The App slug comes from the token action, and the
publisher verifies the corresponding bot user and numeric ID before updating
that bot's marked comment. Human comments and other bots' reports are untouched.

**The comment workflow must be present on the repository's default branch to
start receiving `workflow_run` events.** Until then, use the Actions summary.

## What is measured

| Metric | Measurement |
| --- | --- |
| Package tarball | Compressed bytes from `npm pack --json --ignore-scripts` |
| Package unpacked | Unpacked bytes from the same package artifact |
| Browser bundle | All public browser-entry exports, bundled/minified as ES2022 ESM |
| Browser bundle gzip | Gzip bytes of that same bundle |
| Replay by tier | Median and nearest-rank p95 elapsed milliseconds for navigation, async form and stateful login/cart/order |
| Execution outcome | Attempt count, failures, engine-reported and independently observed LLM calls per tier |

The browser bundle uses one esbuild version and identical options for both
engines. It is a whole-entry comparison, not a consumer-specific tree-shaken
application bundle. Package sizes exclude dependencies installed separately.
Size and median-time rows show signed absolute and percentage changes; a zero
baseline has no defined percentage change. A smaller package can coexist with a
slower tier; these signals are deliberately not collapsed into one score.

The PR checkout supplies the comparison coordinator and worker launcher. The
base checkout supplies the fixture server, local measurement runner and scripted
discovery client for both engines. Baseline discovery creates one canonical
capture per tier. Both engines replay those exact captures with fresh servers,
browser profiles and state for each attempt. One unmeasured warmup per tier and
engine precedes four measured rounds in base/head, head/base, base/head,
head/base order (ABBAABBA). Each engine runs first twice and has the same mean
position. This balances linear position drift in the median, but cannot remove
nonlinear drift or tail noise.
Every attempt uses 20 ms document delay and 40 ms API delay. The raw reports
retain build, fixture and capture hashes, tool versions, request logs, outcomes,
warmups and discovery. Reports also flag uncommitted checkout changes; a local
dirty run is a tooling check, not a measurement of the named commit alone.
Toolchain/version checks are done before measurement;
elapsed time includes per-attempt server/browser startup and awaited cleanup.

Timing is **informational**, not a statistically significant regression gate.
With four observations, nearest-rank p95 is exactly the maximum. It is a
small-sample descriptive value, not a stable tail-latency estimate; shared
runners are noisy.
A performance-only change does not fail CI. A failed attempt, unknown/nonzero
replay LLM usage, incomplete output or incomparable inputs fails the check.
Failed runs cannot establish a speed improvement. A failed warmup withholds the
timing comparison. Fully recorded failed attempts remain in the elapsed-time
distribution; unknown LLM counts display as `unknown`, never zero, and invalidate
the affected tier. Incomplete output still withholds the comparison. Raw attempts
remain available for diagnosis.

The model client is scripted for discovery and forbidden during replay. These
jobs make no paid model calls and use no live application targets. Installing
dependencies and Chrome DevTools MCP still requires registry access. This smoke
does not measure general discovery reliability, healing or actual provider cost;
those remain the larger #169/#214 experiments. The legacy `bench:discover`,
`bench:replay` and `bench:churn` commands are not run by CI.

## Compatibility and ordinary tests

`ci` preserves the `verify` job and separates two test steps:

```sh
npm run test:workspace  # Existing workspace unit/contract suite
npm run test:bench      # Offline runner, sampling, report and publisher contracts
npm test               # Both, once each, for local use
```

Engine compatibility jobs run on `ubuntu-latest`, `macos-latest` and
`windows-latest`, using the existing Node 20 CI line. Each OS typechecks, builds,
runs the real-browser probe fixtures, then performs scripted discovery and
zero-LLM replay of all three local journeys. The existing npm/pnpm packed-consumer
checks remain on Ubuntu. The complete unit suite also remains on Ubuntu;
the OS matrix is specifically a native build/browser compatibility check.
Chrome is supplied by the GitHub-hosted runner image; these workflows do not
install it. The toolchain checks its executable/version and fails explicitly if
it is missing. Both engines on the comparison runner use the same Chrome.
No particular ARM/x64 combination or additional Node version is implied.
All PR target branches trigger validation, including stacked feature PRs.

## Run locally

Install dependencies and build both checkouts first. The baseline must include
the local runner from #169 and support the public APIs used by it. The command
fails explicitly if that prerequisite or a canonical capture is missing.

Install the fixed MCP tool outside the checkouts, install Chrome, and set
`CAIRN_MCP_ENTRY` to its executable JavaScript file. For example on macOS/Linux:

```sh
npm install --prefix /tmp/cairn-ci-tools --ignore-scripts chrome-devtools-mcp@1.3.0
export CAIRN_MCP_ENTRY=/tmp/cairn-ci-tools/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js
# Optional: CHROME_PATH=/absolute/path/to/chrome
npm run bench:ci -- /absolute/base-checkout /absolute/head-checkout /tmp/new-comparison
npm run test:compatibility -- /tmp/new-compatibility-run
```

Use a new output directory on every invocation. `bench:ci` expects already-built
checkouts and runs from the checkout containing this tooling. Rebuild both
checkouts after any source change: `dirty: false` only describes Git status,
and ignored `dist/` files can be stale. Build hashes identify the files measured;
they do not prove those files were compiled from the named commit. CI builds both
exact checkouts before comparing them. The compare
coordinator runs on Linux/macOS; the compatibility command also runs on Windows.
On Windows, set the same environment variable in PowerShell and use native paths.
The driver is launched through Node directly, avoiding shell-specific npm shims.
Windows Chrome's version is read from the executable's version metadata.

`paired.json` is the compact validated input for the PR comment. Individual
`results.json` files contain the full attempt records; `comparison.md` is the
human-readable table. CI retains artifacts for 14 days. No benchmark thresholds
or branch-protection settings are changed by these workflows.
