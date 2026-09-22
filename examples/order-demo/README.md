# A checkout, from discovery to a real failure

This is the first demo for [#255](https://github.com/team-poem/cairn/issues/255).
It uses the existing public cairn API. It makes no changes to discovery, healing,
replay, or the app-context experiment in #252.

The sample shop sells one fictional notebook. Its orders are ephemeral, with no
accounts, payments, shipping, or external services. Use only the sample identity
`Alex Demo` / `alex@example.test`.

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
a new output directory. Existing recordings are never overwritten. `npm start`
uses `.artifacts`; copy a selected alternate recording there before previewing.

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
request. The recorder requires both a failed POST assertion and observed 500
traffic, rather than inferring success from the URL or screenshot. A separate
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

During preparation, one default `gpt-5.5` discovery finished after recovering from
an email-label targeting error, then the host recorder failed because its initial
reporter used the wrong method. A second discovery picked the email label again
and exhausted ten steps. These attempts are not a reliability benchmark. The
published recording, if complete, identifies its own model and source hashes.

Before changing the main GitHub/npm README positioning, ask developers unfamiliar
with cairn to try this example. Observe whether they can explain discovery versus
replay, connect a saved step to a browser action, distinguish a repaired test from
a broken application, and reproduce it locally. Record setup time and sticking
points. External-user validation has not happened yet.
