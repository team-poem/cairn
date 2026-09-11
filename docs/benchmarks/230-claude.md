# #230 — self-heal measurement (Claude Sonnet 5 · Opus 5)

In the existing bench, the v2 change (renaming a label) was absorbed by the role and position fallback
of the frozen target, so self-heal never ran once (0 repairs in both #170 and #228). This measurement
introduces a change the fallback cannot resolve, and measures whether a real model repairs it and
**whether the next run of the saved repair passes with 0 LLM calls**.
It is a result for one change in one fixture, not a general self-heal success rate.

## Change design — fixture v3

On the cart page of the `stateful` journey (login → cart → order), the `Place order` control was
changed from a `<button>` to an `<a href="/done">`. The name, the `/api/order` POST, the arrival at
`/done` and the completion check are unchanged, and the remaining labels that v2 used to change keep
their v1 names. The frozen target `{"text":"Place order","role":"button","index":0}` looks for the name
within the same role, and falls back to role and position when it is not found, but on a page with no
buttons at all both fail. v3 does not exist for any tier other than `stateful` (config validation
rejects it). Implementation: `bench/local/server.mjs`.

## Conditions

- Source: `45adbb87b1507c1569771f2af1cb0891fc8d3cc4` (branch `feat/230-self-heal-bench`, clean checkout,
  `dirty: false`). Engine build SHA-256 `034a7e7131559cef2fdf52fd80f4b88ccbdc06334caf2ec2f3a0c9fd65232c47`,
  the same build as the #228 measurement (only the bench code changed, `packages/harness` is unchanged).
- Models: `claude-sonnet-5`, `claude-opus-5`. Claude Code CLI `2.1.268`, Chrome `153.0.8010.36`,
  Node `v26.5.1`, Chrome DevTools MCP `1.8.0` (`--isolated --headless`).
- Config: `bench/local/heal.claude-sonnet-5.json` (SHA-256 `e1d37594…8cd71c3`),
  `bench/local/heal.claude-opus-5.json` (`ebb16a78…a71303`). Journey `stateful` only; arms `agent`
  (explore every time) and `cairn` (explore once then replay, with heal enabled); versions
  `v1, v1, v1, v3, v3, v3`; document latency `[0, 20]`ms, API latency `[0, 40]`ms, `maxSteps 20`. The caps
  are the same as the existing `cost.*.json` (Sonnet 400 calls and $6, Opus 400 calls and $12). The
  existing v1/v2 fixtures, configs and results were not changed.
- Run schedule (UTC, 2026-09-11): pilot 08:44:37–08:45:29. The main measurement ran Sonnet
  08:45:53–08:50:40 and Opus 08:45:58–08:50:10 **concurrently** (each attempt with its own server, Chrome
  profile and state). Do not use elapsed time to compare model speed. The no-heal replay check was Opus
  08:50:36–08:50:46 and Sonnet 08:50:56–08:51:06.
- Failures, budget stops and retries: none. No runs were discarded. Before the main measurement, a
  wiring check using a script source (no LLM) confirmed that v3 breaks the fallback. It ran on an
  uncommitted tree, so it is not included in the evidence.

## Verification sequence and results

Each step was confirmed from the cost runner's records (`records[]`) and from a separate replay run.

1. **Discover with a real model and freeze** — cairn run 1 (v1), 7 calls. Frozen steps: the `Username`
   input, the `Log in` button, the `Add to cart` button, the `Cart` link, and the `Place order` **button**.
   Both models produced the same shape.
2. **Replay before the change** — runs 2 and 3 (v1) passed, with engine and observed calls both 0.
   Separately, the same freeze was replayed against v1 in LLM-forbidden replay mode: pass, 0 calls.
3. **Fail without heal after the change** — the same freeze replayed against v3 in LLM-forbidden replay
   mode gave, for both models, `step 6/6 blocked: no element matching {"text":"Place order","role":"button","index":0}`, 0 orders and 0 calls.
4. **Run the same capture with heal enabled** — in run 4 (v3), 1 locator self-heal and 1 call.
   The repair re-froze `Place order` as a `link`, and the other steps and assertions are unchanged.
5. **Replay the repair in a new browser against a reset app** — runs 5 and 6 (v3) replayed the hash of
   the repair saved by run 4 (each run with a new server, browser and session).
6. **Final run** — run 6: fixture complete (1 order), verdict pass, engine and observed calls both 0.

| Model | Discovery (1 run) | Repair (run 4) | Replay after repair (runs 5 and 6) | cairn cumulative over 6 runs | agent cumulative over 6 runs |
| --- | ---: | ---: | ---: | ---: | ---: |
| Sonnet 5 | $0.042799 · 7 calls · 15,119 tokens | $0.006370 · 1 call · 1,299 tokens | 2/2 pass · 0 calls | $0.049169 · 8 calls | $0.265392 · 42 calls |
| Opus 5 | $0.087434 · 7 calls · 14,476 tokens | $0.013444 · 1 call · 1,215 tokens | 2/2 pass · 0 calls | $0.100878 · 8 calls | $0.545089 · 42 calls |

- Repair success: 3 of 3 attempts (pilot Sonnet 1, main measurement Sonnet 1 and Opus 1). Looking at the
  main measurement alone, it is 2/2. The denominator is the number of actual repair attempts.
- All attempts succeeded, 24/24 (the pilot's 3/3 is counted separately). All 10 replays (the pilot's 1 is
  counted separately) used 0 LLM calls.
- The crossover is run 2 for both models. The agent arm kept exploring with 7 calls in every run, on v3 from run 4 onward as well.
- The costs are the provider-returned conversion at API list price and include the share of the helper
  model (`claude-haiku-4-5-20251001`). The per-model share of the 1 repair call: Sonnet $0.005276
  plus Haiku $0.001094, Opus $0.012350 plus Haiku $0.001094.
- All token fields were reported in this run (`usageComplete: true`).
- The assertions both models froze are `no-failed-requests`, `no-console-errors` and `navigated /done`,
  and `request-status` for `/api/order` was not frozen. Goal completion was confirmed separately from
  the verdict, through the fixture oracle (`orderCount: 1`, `complete: true`), and the server responds
  at `/done` only when there is 1 order.

### Capture hashes

| Run | freeze (v1) | Repair (v3, saved by run 4) | Hash replayed by runs 5 and 6 |
| --- | --- | --- | --- |
| Sonnet 5 | `08c942178614ed359a7e31ef964bc3fcbd6430cacbff315e1042e52b3b3ecf76` | `f46e052a15ea71e1497ad00322d4633624591e55bd2b3399bb42999b6d87808b` | same as the repair |
| Opus 5 | `f0661ce360ad9a46dc770cf30b704f729ee155a4c1b8aa11b7d759093e4ecf76` | `96983640e667c4be9152949b19d1a3747bf9b78ce7b2d128e4391df65266bd88` | same as the repair |

The fixture SHA-256 values are v1 `62a54b68c644cf8e…` and v3 `f9b459bbcfd871fc…` (full values in the JSON).

## Pilot

Before the main measurement, `bench/local/heal.pilot.claude-sonnet-5.json` (SHA-256 `070a39c3…6cb6d10ab`,
cairn only, `v1, v3, v3`, caps of 40 calls and $1) was used to check that v3 breaks a real model's freeze.
Result: discovery 7 calls at $0.048760, repair 1 call at $0.006362, and a replay of the repair passing
with 0 calls. It is not added into the main measurement.

## Evidence

- [`230-claude.json`](230-claude.json): a subset of the original `results.json` (absolute paths, stacks
  and the ledger removed), with per-attempt records, summaries, capture hashes and steps, plus the
  SHA-256 of the original files. The originals are in the gitignored
  `bench/results/heal-{pilot-sonnet,sonnet,opus}-1/` and `heal-{sonnet,opus}-1-replay-{v1,v3}/`.
- [`230-evidence.mjs`](230-evidence.mjs): builds the JSON above from the original directories (`distill`),
  and redraws the tables from the JSON alone (`table`). No new model calls.

```sh
node docs/benchmarks/230-evidence.mjs table docs/benchmarks/230-claude.json
```

## Re-running

From the repository root, on a clean checkout of the commit above. The output directory must be a new path.

```sh
ENGINE_COMMIT=$(git rev-parse HEAD)
npm run bench:local -- cost --config bench/local/heal.claude-sonnet-5.json --runs 6 \
  --engine-commit "$ENGINE_COMMIT" --out bench/results/heal-sonnet-new
npm run bench:local -- replay --config bench/local/heal-replay.v1.json --runs 1 \
  --engine-commit "$ENGINE_COMMIT" --captures bench/results/heal-sonnet-new/captures \
  --out bench/results/heal-sonnet-new-replay-v1
npm run bench:local -- replay --config bench/local/heal-replay.v3.json --runs 1 \
  --engine-commit "$ENGINE_COMMIT" --captures bench/results/heal-sonnet-new/captures \
  --out bench/results/heal-sonnet-new-replay-v3
node docs/benchmarks/230-evidence.mjs distill out.json sonnet=bench/results/heal-sonnet-new \
  sonnet-replay-v1=bench/results/heal-sonnet-new-replay-v1 sonnet-replay-v3=bench/results/heal-sonnet-new-replay-v3
```

For Opus, change the config file and the output names. GPT-5.6 Sol, Terra and Luna use
`bench/local/heal.gpt-5.6-*.json` as is (same journey, version schedule, latencies and `maxSteps`, Codex
medium, a 160-call cap). The second replay command (v3) is **supposed to fail**, and the CLI returns exit code 1.
