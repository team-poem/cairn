# #230 — self-heal measurement (GPT-5.6 Sol · Terra · Luna)

All three models repaired a real UI change in **1 call**, and passed the next two runs of the saved
repair with **0 LLM calls**. The main measurement was 36/36 successful, with 3/3 actual repair attempts
successful. It measures one button to link change in one local fixture, and does not mean a general
self-heal success rate or a model quality ranking.

## Conditions and sources

- Common source: `45adbb87b1507c1569771f2af1cb0891fc8d3cc4`, with `dirty: false` for all three measurements.
  It is the same commit as the [Claude measurement](230-claude.md). The write-up was added after the
  Claude evidence commit `db3a96ab74a93e09947d1033869a19ba1b88d4f7`.
- Engine build SHA-256: `034a7e7131559cef2fdf52fd80f4b88ccbdc06334caf2ec2f3a0c9fd65232c47`.
  It is the same build as Claude's and the #228 measurement's, and the engine code was not modified.
- Codex CLI `0.146.0`, Node `v26.5.1`, Chrome `153.0.8010.36`, Chrome DevTools MCP `1.8.0`.
- Config: `bench/local/heal.gpt-5.6-{sol,terra,luna}.json` as is. `medium` for each model,
  a 160-call cap, tier `stateful`, arms `agent` and `cairn`, 6 runs each for 12 attempts in total.
- Version schedule: `v1, v1, v1, v3, v3, v3`. Document latency `[0,20]`ms, API latency `[0,40]`ms,
  `maxSteps: 20`. The goal is login → add one book to the cart → order.
- v3 changes the cart's `Place order` button into a link with the same name. The `/api/order` POST and
  the `/done` completion condition are kept. The existing v1/v2 bench and the #228 results are preserved as separate measurements.
- 2026-09-11 UTC: Sol 09:04:22–09:11:13, Terra 09:04:26–09:10:46,
  Luna 09:04:31–09:10:48. The three models ran concurrently, and each attempt uses its own server,
  browser and state. Do not use elapsed time to compare model speed.
- There were no GPT pilots, automatic retries, aborts or excluded runs. Separate from the main
  measurement, the heal-disabled control runs are 1 each on v1 and v3 per model, 6 in total. The 3
  intended failures on v3 are not mixed into the success rate of the main measurement.

## Results

Tokens are the sum of the observed plain input, cache read, cache write and output. `usageComplete` on
every main measurement record and `tokensComplete` in the summary are true. Cache tokens are already
separated out of plain input, and reasoning tokens are included in output, so they are not added again.
The call count is the bench's number of LLM completion calls.

| Model | Discovery (run 1) | Repair (run 4) | Replay after repair (runs 5 and 6) | cairn cumulative over 6 runs | agent cumulative over 6 runs |
| --- | ---: | ---: | ---: | ---: | ---: |
| GPT-5.6 Sol | 85,720 tokens · 7 calls | 11,417 tokens · 1 call | 2/2 pass · 0 calls | 97,137 tokens · 8 calls | 505,949 tokens · 42 calls |
| GPT-5.6 Terra | 83,988 tokens · 7 calls | 11,421 tokens · 1 call | 2/2 pass · 0 calls | 95,409 tokens · 8 calls | 506,453 tokens · 42 calls |
| GPT-5.6 Luna | 74,028 tokens · 7 calls | 9,994 tokens · 1 call | 2/2 pass · 0 calls | 84,022 tokens · 8 calls | 445,270 tokens · 42 calls |

The three models made 150 calls in total, 50 per model, so the cap was not reached. The Codex CLI does
not report dollar cost, so `costUsd` on each record is `null`. The cumulative `costUsd: 0` in the
summary is an empty sum of known costs and **does not mean it was free** (`costComplete: false`, `comparable: false`). Below we add an API unit-price estimate kept separate from the original. No cost crossover point is given.
These are not compared directly against Claude's provider-reported amounts to build a price or quality ranking.

## Dollar conversion — estimate at Standard API unit prices

As with the existing #228 table, the README shows the dollar estimates and the call counts first. The
token table above and the original `230-codex.json` are kept as they are. The [official price list](https://developers.openai.com/api/docs/pricing)
was rechecked on 2026-09-11, and the [#228 price snapshot](228-openai-prices.json) recorded the same day is reused.
The unit is USD per million tokens.

| Model | Plain input | Cache read | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| GPT-5.6 Sol | $4.00 | $0.40 | $5.00 | $20.00 |
| GPT-5.6 Terra | $2.00 | $0.20 | $2.50 | $12.00 |
| GPT-5.6 Luna | $0.20 | $0.02 | $0.25 | $1.20 |

`estimated USD = (plain input × input price + cache read × read price + cache write × write price + output × output price) / 1,000,000`

The cache discount is applied only to cache tokens that were actually observed. The largest per-run
input totals for Sol, Terra and Luna are 85,527, 85,499 and 74,666 tokens respectively, so the upper
bound for an individual request is also at or below the short-context threshold of 272,000 tokens.
Standard is an assumption made for the calculation, not a service tier reported by the CLI. It is not
an amount actually charged on top of a subscription, and Batch, Flex, Fast, regional surcharges, taxes
and individual contracts are not reflected.

| Model | Discovery, estimated USD | Repair, estimated USD | cairn 6 runs, estimated USD | agent 6 runs, estimated USD |
| --- | ---: | ---: | ---: | ---: |
| GPT-5.6 Sol | ~$0.237219 | ~$0.045860 | ~$0.283079 | ~$1.745185 |
| GPT-5.6 Terra | ~$0.056860 | ~$0.006834 | ~$0.063694 | ~$0.549220 |
| GPT-5.6 Luna | ~$0.008757 | ~$0.000582 | ~$0.009339 | ~$0.066650 |

The [conversion JSON](230-codex-usd.json) preserves the token items per step and per arm, the estimates
before rounding, and the SHA-256 of the observed files and of the price snapshot. The
[conversion script](230-estimate-usd.mjs) sums in integer nanodollars, following the same
calculation as #228, and does not convert incomplete usage. It regenerates with no new model calls.

```sh
node docs/benchmarks/230-estimate-usd.mjs
```

## Verifying the repair and goal completion

1. cairn run 1 (v1) saved the capture that a real model discovered. Runs 2 and 3 passed on that hash,
   with engine and observed calls both 0.
2. Replaying that same capture with heal disabled passed on v1, and on v3 all three models failed with
   `step 6/6 blocked: no element matching {"text":"Place order","role":"button","index":0}`.
   The v3 control runs had 0 orders and 0 engine and observed calls, and exit code 1 is the expected result.
3. Run 4 of the main measurement (v3) replayed the original hash and passed with 1 locator repair and 1 LLM call.
   The only step change in the saved repair is `role: button` → `role: link` on the final click.
   The original step's intent and expect, and the scenario assertions, were kept.
4. Runs 5 and 6 replayed the hash of the repair saved by run 4, and in a new browser with reset state
   confirmed a passing verdict, `oracle.complete: true`, `orderCount: 1`, and engine and observed calls both 0.

| Model | Original SHA-256 | Repair SHA-256 (replayed by runs 5 and 6) |
| --- | --- | --- |
| Sol | `92f9db92e9fffce4eb365fdd75eeb86df14f531a33ccc441e87afeefd45680b6` | `841cd267d3b9a70325036c66cc84e2bebfc6a5670582f0e15fd49848a98de8e0` |
| Terra | `ed9d0150e9e39ffcbb274c3dd51d7364a840da3c81281c73cafa44b82173b556` | `0962485a120f98caddfef73412dd70ec7934cea63c03f8736c0a8a6f9e43e248` |
| Luna | `bb26c6fb617c612a6c5ef22b24c6d3751ce711ba55f25e5c6843588455c21462` | `d12ad9f543bc61bf500f9df1d2d36e571c3fbc80bec12ba97e9f86de3d166697` |

For all three models the frozen assertions are `no-failed-requests`, `no-console-errors` and `navigated /done`.
There is no `request-status` assertion for `/api/order`. Order success was confirmed separately from the
verdict, through the 1 order in the fixture oracle. There is no `waitFor` step, so `waitFor.text` repair
is not covered by this measurement. Also, a successful agent discovery requires a replayable scenario
and oracle completion, while a successful cairn replay also requires the frozen assertions, so the
success criteria of the two arms are not the same procedure.

Combined with [Claude](230-claude.md), the main measurement is 60/60 successful, with 5/5 actual repairs
successful and 10/10 replays after repair successful with 0 LLM calls. The separate Claude pilot is not included in this denominator.

## Evidence and regeneration

[`230-codex.json`](230-codex.json) is a subset of the original results. It preserves the 36 main
measurement records and 6 control records, the run environment and config, the engine and observed call
counts, the capture steps, assertions and hashes, and the SHA-256 of the original files. Absolute
paths, stacks and duplicate ledgers are excluded. The Claude JSON was also regenerated from its
originals with the same distiller, adding engine call counts and assertions, and the existing measured values are unchanged.

The originals are preserved in the ignored `bench/results/heal-{sol,terra,luna}-1/` and each
`-replay-v1/` and `-replay-v3/`. The tables regenerate with no new model calls.

```sh
node docs/benchmarks/230-evidence.mjs table docs/benchmarks/230-codex.json
```

## Re-running

Run from a clean checkout of the common source commit, and use a new path for the output directory.
The actual measurement built once, then ran `node bench/local/cli.mjs`, which the npm commands below
invoke, concurrently for each model. The commands below reproduce it from the build onward with the same configuration.

```sh
ENGINE_COMMIT=$(git rev-parse HEAD) # 45adbb87b1507c1569771f2af1cb0891fc8d3cc4
npm run bench:local -- cost --config bench/local/heal.gpt-5.6-sol.json --runs 6 \
  --engine-commit "$ENGINE_COMMIT" --out bench/results/heal-sol-new
npm run bench:local -- replay --config bench/local/heal-replay.v1.json --runs 1 \
  --engine-commit "$ENGINE_COMMIT" --captures bench/results/heal-sol-new/captures \
  --out bench/results/heal-sol-new-replay-v1
npm run bench:local -- replay --config bench/local/heal-replay.v3.json --runs 1 \
  --engine-commit "$ENGINE_COMMIT" --captures bench/results/heal-sol-new/captures \
  --out bench/results/heal-sol-new-replay-v3
```

For Terra and Luna, change the config and the output names. The v3 replay must return exit code 1.
Run the write-up step on a commit that has the augmented `230-evidence.mjs`. `distill` only reads the
original directories, and does not change the measurement source commit.

```sh
node docs/benchmarks/230-evidence.mjs distill out.json \
  sol=bench/results/heal-sol-new \
  sol-replay-v1=bench/results/heal-sol-new-replay-v1 \
  sol-replay-v3=bench/results/heal-sol-new-replay-v3
```
