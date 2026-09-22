# A checkout, from discovery to a real failure

This is the first demo for [#255](https://github.com/team-poem/cairn/issues/255).
It uses the existing public cairn API. It makes no changes to discovery, healing,
replay, or the app-context experiment in #252.

The sample shop sells one fictional notebook. Its orders are ephemeral, with no
accounts, payments, shipping, or external services. Use only the sample identity
`Alex Demo` / `alex@example.test`. The sample email is prefilled and read-only;
discovery fills the name and completes the order.

## Run it

From a repository checkout, install with `npm ci` and build with `npm run build`.
Then:

```sh
cd examples/order-demo
CAIRN_LLM_BACKEND=codex DEMO_MODEL=gpt-5.6-sol npm run record
npm start
```

Open <http://127.0.0.1:4319>. Keep that port free during recording. Node 22.12+,
Chrome, and an authenticated model backend are required. The pinned driver is
`chrome-devtools-mcp@1.8.0`; npm may download it on first use. Other installed
backends supported by `createLlmClient` work through `CAIRN_LLM_BACKEND`.

The downloadable source archive includes a tarball of the exact engine build
captured before recording. Extract it, run `npm install`, and use the same record/start commands.
It does not require the monorepo. Plain `npm start` serves the shop without a
recording and clearly says that execution evidence is not available yet.

Recording makes real model calls, capped at 24 by default across all six stages.
`DEMO_MAX_CALLS` changes that ceiling, not a dollar budget. CLI cost is unknown;
the demo does not convert subscription calls into invented dollar savings.
`PORT` changes the recording origin and the preview port. `DEMO_OUTPUT` selects
a new output directory. Existing recordings are never overwritten. Set the same
`DEMO_OUTPUT` for `npm start` and `npm run build` to select an alternate recording.

## What the recording must prove

| Stage               | App                              | Required outcome                                                           |
| ------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| Discover            | Original button                  | Real model finishes; a non-vacuous POST order proof is saved               |
| Replay              | Original button                  | Pass, `work` proof, zero engine and observed model calls                   |
| Changed UI, no heal | Order button becomes a link      | Original scenario fails, zero model calls                                  |
| Heal                | Same link                        | Pass under original assertions; measured model calls; save verified repair |
| Repaired replay     | Same link                        | Load saved repair; pass with zero model calls in a fresh browser           |
| Application defect  | Same link, order API returns 500 | Fail even with healing enabled; no repair offered for saving               |

The broken app deliberately displays its completion screen after the failed
request. The recorder requires an original replay trace assertion that saw POST
500, the server's matching failure, and a failed original goal after any repair
attempt, rather than inferring success from the URL or screenshot. A separate
server-side order oracle confirms whether the application accepted an order.
Every stage starts a fresh server and isolated browser at the same origin.

The viewer displays screenshots captured after actual driver actions, the saved
scenario, trace, verdict, duration, and measured completion calls. These are
**recorded executions, not live runs or simulated animations**. Durations include
model latency, browser startup, and screenshot overhead; this is not a speed
benchmark. Zero replay calls requires both the engine meter and a throwing client
at the host seam to observe zero.

Artifacts live in ignored `.artifacts/`. `manifest.json` retains source hashes,
the recording checkout commit, the preserved engine archive's SHA-256 and version,
model ID, and every frame. Partial or failed recordings
remain on disk, but the viewer refuses to present them as a completed demo.

## Local recording on 2026-09-22

The complete recording used `codex:gpt-5.6-sol`, engine 2.9.2, and isolated Chrome.
The preserved engine archive SHA-256 is
`2477211a9364b4cc2381b0554ee7dbee23feebb67116d97f5ca1905c99c8ea1e`.
The manifest also carries the exact recorder and shop source hashes.

| Stage | Observed model calls | Outcome |
| --- | ---: | --- |
| Discovery | 7 | Grounded order scenario saved |
| Replay | 0 | Pass, `work` proof |
| Changed UI without healing | 0 | Target failure detected |
| Repair | 1 | Pass under original assertions; repair saved |
| Repaired replay | 0 | Pass, `work` proof |
| Broken order API, healing enabled | 7 | Original 500 detected; final verdict remains failed |

The last stage's trace event 11 records the original POST 500. After outcome
re-discovery, the final request list is empty and the original order assertion
fails for missing evidence. The two server-side order attempts both returned 500;
no repaired scenario was offered. The viewer discloses this evidence-retention
limit instead of presenting the final result as if it still contained the 500.
This is one demonstration, not a success-rate or cost benchmark.

## Build and deploy

```sh
npm test
npm run build
cd dist
npm start
```

The build refuses an incomplete recording or changed recording sources. `dist/`
contains a Node server, static assets, execution evidence, and a runnable source
archive. No model credentials or LLM execution endpoint is deployed. Generated
recordings, archives, and `dist/` are not committed.

The initial local server binds to loopback. A Node host can run the built site with
`HOST=0.0.0.0 PORT=8080 npm start`; use the port required by the hosting platform.
Do not treat a running local preview as a deployed demo.

## Limits and the next experiment

This demonstrates one specific role change, not arbitrary repair reliability.
The original assertions are preserved. A UI change that keeps the locator valid
may need no model at all. The engine can fail to discover a flow, exceed the step
limit, or fail to repair it; those are outcomes to retain, not edit into passes.

Earlier versions required entering an email and exposed both a visible label and
an input under the same accessible name. One `gpt-5.5` discovery finished after
recovering from a label-targeting error, then an initial recorder API mistake
stopped the replay. Later `gpt-5.5` and `gpt-5.6-sol` attempts exhausted ten steps
trying to type into a StaticText label. A diagnostic confirmed that the input was
present in the observation; role-less targeting could select its same-name label.
Prefilling only the email still left the same ambiguity on the name field.

The small demo now prefills the sample email and exposes the name input's label
once, through `aria-label`; the visible duplicate is hidden from the accessibility
tree. This narrows the demonstrated conditions. It does not fix or establish
support for the earlier ambiguous form. The engine is unchanged.

Two environment checks also stopped before discovery: the installed Codex CLI did
not support `gpt-6-astra`, and Claude Code was not authenticated. These are not
model-quality samples. This preparation is not a reliability benchmark; a
complete recording identifies its own model and exact source hashes.

The shop uses `history.pushState` after its order request. In preparation, the
original replay correctly detected POST 500, then outcome re-discovery returned
an empty request list and failed the unchanged goal for missing evidence. The
viewer distinguishes the original failure in the trace from the final verdict;
it explicitly discloses when the 500 is absent from the final result. No repair is
saved. Full-navigation evidence retention is also a known limitation in the #256
pilot; whether these observations have the same cause needs separate diagnosis.

Before changing the main GitHub/npm README positioning, ask developers unfamiliar
with cairn to try this example. Observe whether they can explain discovery versus
replay, connect a saved step to a browser action, distinguish a repaired test from
a broken application, and reproduce it locally. Record setup time and sticking
points. External-user validation has not happened yet.
