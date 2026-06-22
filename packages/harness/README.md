# @cairn/core

![cairn banner](https://raw.githubusercontent.com/team-poem/cairn/main/banner.svg)

The engine behind [cairn](https://github.com/team-poem/cairn) — browser tests an AI
discovers once, replays deterministically (no LLM in the loop), and self-heals when the UI
drifts. Model- and browser-agnostic; embed it or drive it from the `cairn` CLI.

```sh
npm install @cairn/core
```

```sh
# discover an LLM walks the app once and writes a scenario
cairn discover "follow the link to learn more" --url https://example.com --freeze t.json
# replay deterministic, no LLM; non-zero exit on failure (CI gate)
cairn replay t.json
# heal repair a broken step via the LLM and re-freeze
cairn replay t.json --heal --freeze t.json
```

Embed it — every stage is an injected port:

```ts
import { runScenario } from "@cairn/core";

const { result } = await runScenario(scenario, { heal: true });
if (!result.verdict.passed) process.exit(1);
```

No API key needed if you have **Claude Code** installed (cairn shells out to it); set
`ANTHROPIC_API_KEY` to use the Anthropic API instead.

**Full docs, design, and the loop diagram:** https://github.com/team-poem/cairn

MIT
