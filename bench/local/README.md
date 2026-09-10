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

Both commands write `results.json` and `results.md`. To regenerate Markdown from
an existing JSON report without rerunning the browser or provider, run from the
repository root (replace the two paths):

```sh
node --input-type=module -e 'import { readFile, writeFile } from "node:fs/promises"; import { renderMarkdown } from "./bench/local/report.mjs"; await writeFile(process.argv[2], renderMarkdown(JSON.parse(await readFile(process.argv[1], "utf8"))));' \
  /path/to/results.json /path/to/regenerated.md
```

Discovery saves the **engine's returned Scenario**, plus a hash-bound metadata
sidecar, for every successful attempt. Failed discoveries stay in the discovery
denominator. Select one explicit discovery round (`captures/run-1`, for example) for replay; there is no
automatic selection of the most successful capture. Captures are immutable and
validated before opening a browser. The sidecar records canonical origin, fixture
source/version/hash, discovery source, engine identity and scenario bytes hash.

The scripted client supplies decisions and assertion proposals to real engine
discovery. It incurs no provider calls and measures plumbing, not LLM discovery
reliability. Its repair decisions are deliberately unsupported. To inspect v2
label churn, copy the configuration, set `fixtureVersion` to `v2`, and run replay
or heal against the same v1 captures. Replay always forbids LLM calls. A
successful v2 replay is unaided survival. Click/type targets can survive renamed
labels through an unambiguous role/index fallback. A frozen `waitFor.text`
condition still checks its captured text and has no such locator fallback: for
example, waiting for `Add to cart` can fail after that label becomes `Add item`
even when clicking the renamed control could resolve. This outcome depends on
the specific frozen steps and changed labels, not an inherent property of a tier.
A scripted heal run can fail if an actual repair decision is needed.

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
- `maxSteps`: optional positive decision limit for discovery and outcome
  rediscovery during healing (default 20).
- `llm`: required for discovery/heal, ignored for replay.

Requested delays and observed request elapsed times are distinct in JSON. A
closed request may have a null observed time. Attempt elapsed time includes
server/browser startup and awaited cleanup. Timers, cookies, authentication,
cart and order state never cross attempts. The v2 fixtures change visible action
labels while keeping the journey and completion status stable. Each attempt uses
one constant delay per route class. The schedule has no per-request jitter or
response-order injection and cannot deliberately reorder concurrent requests
within the same class. Different document/API delays and natural timing still
exist; these runs do not establish race-condition coverage.

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
there is no persistent budget service. Conservatively, reaching either limit
marks the report incomplete and makes the CLI exit nonzero even when the final
requested engine attempt returned successfully. This status does not imply
unattempted work: requested/attempted/completed counts and each engine/oracle
outcome remain intact.

## Compare cost against discovering every run

The `cost` mode answers one question with a measurement instead of an estimate:
over a run of runs, does discovering once and paying for the occasional repair
cost less than discovering every time? Two arms cover the same tiers, the same
churn schedule and one shared budget.

- `agent` discovers on every run. This is what an LLM agent driving the browser
  each time costs.
- `cairn` discovers once, replays after that, heals when the application changes
  underneath it, and carries the repair into every later run.

```sh
ENGINE_COMMIT=$(git rev-parse HEAD)
npm run bench:local -- cost --config bench/local/cost.example.json --runs 4 \
  --engine-commit "$ENGINE_COMMIT" --out bench/results/cost-1
```

`cost.claude-sonnet-5.json` and `cost.claude-opus-5.json` are the two schedules the published
README numbers came from: three tiers, six runs, the app changing on run 4. Reuse them unchanged to
add a model, so the rows stay comparable, and change only the `model` and the spending threshold.
`cost.example.json` is the offline smoke instead.

`--runs` must equal the number of entries in `fixtureVersions`. The shipped
example is an offline smoke: it changes nothing under the freeze and its
scripted source spends nothing, so it exercises the arms rather than measuring
money. A real comparison replaces `llm` with the `llm` object from the section
above and puts churn in the schedule, because a scripted repair decision is
deliberately unsupported.

Configuration adds two fields to the reliability config and needs no captures:

- `arms`: one or more of `agent`, `cairn`. Both, to get a comparison.
- `fixtureVersions`: one version per run, so "the application changed at run k"
  is a property of the schedule. Both arms then meet the same change on the same
  run. The first run must be `v1`, the version canonical discovery starts from.
- `runs`: at least 2. One run cannot show a crossover.

Every scenario an arm replays is written to `captures/`, the freeze and each
repair under its own name, and every run records the hash of the scenario it
replayed, so the runs after a heal are reproducible from the artifacts. An
output directory that already holds captures is refused before the first browser
opens, rather than at the first save, which would be after an arm was paid for. A discovered or healed scenario that navigates off the fixture origin
is rejected rather than carried forward: this path has neither `loadCapture` nor
a replay environment's allowed hosts to stop an offline benchmark from reaching
a real host. A replay that reports no usage, or reports more LLM calls than the
benchmark observed, fails rather than counting as free.

Both arms of one tier run on a single reserved port, so a capture's frozen URLs
match every later run and no replay environment is needed. That matters: under a
replay environment the engine deliberately withholds the healed scenario, and a
repair that cannot be re-frozen would make the cairn arm pay for the same break
on every run after it. Each run still gets its own server, browser and state.

The report gives, per tier and per arm, cost and tokens as running totals
against the run index, how many runs called the model, how many repairs were
carried forward, and the crossover: the first run where the cairn arm has cost
less and stayed there. A token total counts every billed field, cache
creation included, and reads as a lower bound once a call reported no usage or
reported only some of those fields. It is a count, and the runner records no
per-model price, so a dollar figure cannot be derived from it. A tie is not a crossing.

One CLI call can bill more than one model: the tool runs a small helper model
of its own beside the model under test. An arm's cost column is everything the
run spent, and a per-model line under each tier says what each model's share
was. Where that line says a model was priced at list, the provider computed its
share from published API rates, so it is what an API caller would have paid for
the same tokens even when the run itself went through a subscription. A model
the provider priced on some other basis, or did not price, says so instead of
reading as free.

The crossover is withheld rather than guessed whenever it would be a claim: a
scripted source makes no paid call, an arm that stopped short of the schedule
was never compared over it, a run whose cost the provider never reported adds
nothing to that arm's total, and a failed run costs nothing, so a broken arm
would read as a cheap one. The report names which of these
withheld it. It is also measured from the second run only, since on the first
both arms do the same work on the same fixture and any difference there is
provider pricing noise. A discover run fails when no replayable
scenario came back or the fixture never completed; a replay run additionally has
to satisfy the frozen assertions, so the two arms' failure counts are not the
same measurement. Regenerate the Markdown with `renderCostMarkdown` in place of
`renderMarkdown`.

A cost run also writes `cost-<tier>.svg` beside its report: cumulative spend
against the run index, one line per arm, with the crossover marked. It is drawn
from the JSON and nothing else, so the picture can be regenerated from the data
that produced it instead of being redrawn by hand, and a tier whose comparison
the report withheld gets no chart rather than a drawn one. Regenerate one with
`renderCostChart(report, { tier })` from `bench/local/chart.mjs`.

A crossover is not a general saving. How often an application breaks a freeze is
the variable that decides the answer, and a schedule fixes it by construction.
Report the schedule with the number.

## Interpret results

JSON preserves engine verdict/proof/failure detail, fixture oracle, observed
usage, locator/step repair counts, capture source, execution LLM source, per-run
errors, request logs and provenance. `engineUsage` retains only usage returned
by the engine; `observedUsage` counts completions at the benchmark seam even if
an engine operation fails or catches a guard error. Existing `usage` fields
remain available. Replay requires both returned and observed call counts to be
measured zero. A green verdict cannot override an
incomplete fixture. Zero repair count with nonzero LLM calls can include outcome
rediscovery, so it does not establish unaided survival.

The Markdown table includes requested, attempted, engine-returned and failed
counts, with separate engine and observed LLM call columns. Discovery's engine
column is `n/a` because discovery returns a Scenario; absent returned usage is
`unknown`. The capture table identifies the execution fixture version/hash and
each distinct canonical scenario hash, fixture version/hash and discovery source.
Repeated captures are deduplicated; missing captures and unavailable legacy
metadata stay explicit. Failure rate uses all attempted runs, including
exceptions. Budget or signal stops preserve counts and mark the report incomplete. All
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
this runner does not change #220 CI structure.
