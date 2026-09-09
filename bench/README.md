# Benchmarks

These scripts measure discovery, frozen-scenario replay, and recovery from UI
renaming. They keep their existing flows and four replays per flow or churn arm.

## Prerequisites

- Node 20 or later and npm. Run `npm ci` from the repository root first.
- Chrome installed. The engine launches it through Chrome DevTools MCP; npm
  must be able to fetch the MCP package if it is not already cached.
- Discovery uses the authenticated `claude` CLI on `PATH` with the Sonnet model.
- Churn uses the engine's configured [LLM backend](../README.md#llm-backends),
  with Sonnet for discovery and Haiku for healing. Leave local port 8077 free.
- Discovery and replay use the live Sauce Demo and TodoMVC sites. Churn serves
  its own local pages. These are manual benchmarks, separate from the offline tests.

## Commands

Run from the repository root:

```sh
npm run bench:discover
npm run bench:replay
npm run bench:churn
```

Each command builds `cairn-engine` first and stops if that build fails. Arguments
after npm's `--` are passed to the selected script. The scripts currently expose
no additional tuning flags; the existing flows, models, and counts are in their source.

| Command | Behavior | LLM use |
| --- | --- | --- |
| `bench:discover` | Discover both flows and save their frozen scenarios | Claude Code calls; reports discovery cost |
| `bench:replay` | Replay each saved flow four times; report journey and verdict counts | No LLM calls |
| `bench:churn` | Discover v1; replay renamed v2 four times without healing and four times with healing | Discovery and any required healing |

Discovery writes `bench/frozen/<flow-id>.json`; replay reads those same files and
skips a flow if its file is absent. Files belong to the checkout containing the
script, independent of the caller's working directory, including paths with spaces.
They are generated, ignored artifacts and must not be committed.

After building, direct invocation also works from another directory:

```sh
node "/path with spaces/to/cairn/bench/benchmark.mjs" replay
```

`npm test` includes offline portability checks with a stub engine. Those checks
exercise paths, command ordering and argument forwarding without Chrome or LLM
calls. Fixture tiers, latency injection and the proposed larger replay sample
remain follow-up work for [#169](https://github.com/team-poem/cairn/issues/169).
