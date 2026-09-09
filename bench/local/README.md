# Local reliability measurements

This runner measures three local journeys: navigation, an asynchronous form, and
login → cart → order. Each attempt owns a fresh random-port HTTP server, browser
process/profile, session store and timer set. Cleanup is awaited before the next
attempt. No external application or asset is required; Chrome DevTools MCP may
need an npm download. The existing `bench:discover`, `bench:replay` and
`bench:churn` commands retain their behavior.

## Run a small scripted smoke

Install the lockfile dependencies with `npm ci`, and install Chrome. The runner
uses the public built `cairn-engine` API and requests
`chrome-devtools-mcp@~1.3.0 --isolated --headless`. Every `bench:local` invocation
builds the engine first. Use a clean checkout and record its full commit hash.
Node 20 or later is required; runtime versions and requested driver arguments are
recorded, rather than assuming a particular Chrome version.

Run from the repository root; every output directory must be new:

```sh
ENGINE_COMMIT=$(git rev-parse HEAD)
npm run bench:local -- discover --config bench/local/smoke.json --runs 1 \
  --engine-commit "$ENGINE_COMMIT" --out bench/results/discover-1
npm run bench:local -- replay --config bench/local/smoke.json --runs 2 \
  --engine-commit "$ENGINE_COMMIT" --captures bench/results/discover-1/captures/run-1 \
  --out bench/results/replay-1
```

Both commands write `results.json` and `results.md`. Discovery saves the **engine's
returned Scenario**, plus a hash-bound metadata sidecar, for every successful
attempt. Failed discoveries stay in the discovery denominator. Select one
explicit discovery round (`captures/run-1`, for example) for replay; there is no
automatic selection of the most successful capture. Captures are immutable and
validated before opening a browser. The sidecar records canonical origin, fixture
source/version/hash, discovery source, engine identity and scenario bytes hash.

The scripted client supplies decisions and assertion proposals to real engine
discovery. It incurs no provider calls and measures plumbing, not LLM discovery
reliability. Its repair decisions are deliberately unsupported. To inspect v2
label churn, copy the configuration, set `fixtureVersion` to `v2`, and run replay
or heal against the same v1 captures. Replay always forbids LLM calls. A
successful v2 replay is unaided survival; role/index fallback can make label
changes survive without a repair. A scripted heal run can fail if an actual
repair decision is needed.

## Configuration and counts

`--runs N`, `--engine-commit FULL_SHA`, `--config FILE`, and `--out DIRECTORY` are
required; replay/heal also require `--captures DIRECTORY`. `N` means attempts
**per selected tier**, separately for each mode. There is no default 300-run
measurement. JSON configuration supplies:

- `tiers`: one or more of `navigation`, `form`, `stateful`.
- `fixtureVersion`: `v1` for canonical discovery; `v1` or `v2` for execution.
- `latency.document` and `latency.api`: nonempty arrays of milliseconds. Attempt
  index `i` uses array entry `i % length` independently for each route class.
  Incidental request order does not advance the schedule.
- `maxSteps`: optional positive discovery step limit (default 20).
- `llm`: required for discovery/heal, ignored for replay.

Requested delays and observed request elapsed times are distinct in JSON. A
closed request may have a null observed time. Attempt elapsed time includes
server/browser startup and awaited cleanup. Timers, cookies, authentication,
cart and order state never cross attempts. The v2 fixtures change visible action
labels while keeping the journey and completion status stable.

## Actual LLM discovery or healing

Use an authenticated current Claude Code CLI on `PATH` supporting JSON output,
`--safe-mode`, `--tools`, `--no-session-persistence`, `--system-prompt` and
`--max-budget-usd`. The supported backend is `claude-code`. Choose the model,
counts and limits explicitly before measurement, replacing the scripted `llm`
object with:

```json
{
  "source": "llm",
  "backend": "claude-code",
  "model": "YOUR_EXPLICIT_MODEL",
  "maxCalls": 20,
  "maxCostUsd": 1
}
```

These are illustrative limits, not a recommendation or an authorization to
spend. Each invocation shares one hard completion-call counter and one measured
cost ledger across all tiers/attempts, including discovery's final assertion
proposal. Tools, customization and session persistence are disabled. Available
usage, returned model IDs and reported cost are retained even on provider failure; missing cost or a
transport timeout stops further paid work with incomplete cost accounting.
There is no automatic retry. `maxSteps` limits browser decisions, not billing.

The dollar value is a **post-call stopping threshold**, not a strict billing cap.
Claude can exceed it by a final call; actual returned cost is retained. The
adapter passes the remaining threshold to each CLI call. See the
[official budget example](https://github.com/anthropics/claude-agent-sdk-python/blob/main/examples/max_budget_usd.py)
and [CLI reference](https://code.claude.com/docs/en/cli-reference). For multiple
invocations, explicitly allocate the remaining budget from previous results;
there is no persistent budget service.

## Interpret results

JSON preserves engine verdict/proof/failure detail, fixture oracle, observed
usage, locator/step repair counts, capture source, execution LLM source, per-run
errors, request logs and provenance. A green verdict cannot override an
incomplete fixture. Zero repair count with nonzero LLM calls can include outcome
rediscovery, so it does not establish unaided survival.

The Markdown table includes requested, attempted, engine-returned and failed
counts. Failure rate uses all attempted runs, including exceptions. Budget or
signal stops preserve unattempted counts and mark the report incomplete. All
failures are still failures even if repeated consistently; failure rate alone
is not an estimate of intermittent flakiness. Replay of one selected capture
cannot establish discovery success or general application coverage. Do not
pool scripted and actual LLM discovery results.

The CLI exits nonzero for failed or incomplete measurements. SIGINT/SIGTERM
request cancellation and cleanup. Generated reports/captures belong under
ignored `bench/results/` or an external output directory, never in a commit.
`npm test` covers the offline fixture, capture, budget, runner and report
contracts without Chrome or paid calls. Large-N, actual LLM and baseline results
remain measurement work for [#169](https://github.com/team-poem/cairn/issues/169);
this runner does not add #214 cost arms or change #220 CI structure.
