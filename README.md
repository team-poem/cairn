<div align="center">
  <img alt="cairn banner" src="banner.svg">
  <p>An AI writes your browser test once. It replays forever with no AI at all, and heals itself when the UI changes.</p>
</div>

# cairn

Agentic-testing engine and CLI for the browser, written in TypeScript.

[![npm](https://img.shields.io/npm/v/cairn-engine.svg)](https://www.npmjs.com/package/cairn-engine)
[![CI](https://github.com/team-poem/cairn/actions/workflows/ci.yml/badge.svg)](https://github.com/team-poem/cairn/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/cairn-engine.svg)](https://www.npmjs.com/package/cairn-engine)
[![license](https://img.shields.io/npm/l/cairn-engine.svg)](LICENSE)

An AI walks your app once to discover the flow and freezes it to plain JSON. From then on it replays deterministically, with no LLM and no hand-written selectors. When the UI changes and a step breaks, the AI returns to heal just that step, then re-freezes.

> A cairn is a stack of stones that marks a trail. It is built once, so the path can be found again. That is the whole idea: find the path once, follow the marker forever, rebuild it when the trail shifts.

cairn is an engine, not a product. The core (`cairn-engine`) is model- and browser-agnostic, and you embed it to build QA tools, CI gates, or monitors. Discovery is paid once. Regression is free.

## Features

- Discover a flow from a plain-language intent, with an LLM, once
- Freeze it to a flat, readable, diffable `*.skill.json` file
- Replay it deterministically, with zero LLM calls, and print the proof (`llm: 0 call(s)`)
- Self-heal a broken step from its recorded intent, then re-freeze
- Multi-locator targets (accessible name, role and index, CSS) that survive redesigns
- Three-layer judgment: did it act, what it looked like, what the requests and console said
- Run a whole case list with `cairn suite`, with your own success criteria merged in
- Survey an app for UX problems with `cairn explore`, with nothing frozen
- Stream the whole run as a versioned event trace (`TraceSink`, `JsonlTraceSink`)
- Seven replaceable ports: `ContextProvider`, `Planner`, `Driver`, `SkillStore`, `Critic`, `Reporter`, `TraceSink`
- Multiple LLM backends, including key-less Claude Code and Codex CLI
- A browser and extension entry (`cairn-engine/browser`) for environments without Node

## Installation

You need Node 20 or later, Chrome, and a model (see [LLM backends](#llm-backends)). The browser is driven via Chrome DevTools MCP and launched automatically.

```sh
npm install -g cairn-engine
```

## Usage

- as a [CLI](docs/guide.md#try-it-in-60-seconds)
- as a [library](docs/guide.md#embed-it)

```sh
cairn discover "log in and open the cart" --url=https://your.app --freeze=cart.skill.json
cairn replay cart.skill.json            # deterministic, exit 1 on failure
cairn replay cart.skill.json --heal     # UI drifted? repair the broken step and re-freeze
```

```ts
import { runScenario, loadSkillFile, saveSkillFile } from "cairn-engine"

const scenario = await loadSkillFile("cart.skill.json")
const { result, healedScenario } = await runScenario(scenario, { heal: true })

if (healedScenario) await saveSkillFile("cart.skill.json", healedScenario)
if (!result.verdict.passed) process.exit(1)
```

## Documentation

| Doc | What it covers |
| --- | --- |
| [`docs/guide.md`](docs/guide.md) | the user guide: CLI, library, suites, explore, skill files, traces, extension points, FAQ |
| [`docs/design.md`](docs/design.md) | the full design, end to end |
| [`spec/core/the-loop.md`](spec/core/the-loop.md) | why discover, freeze, replay, heal |
| [`spec/core/surgical-heal.md`](spec/core/surgical-heal.md) | per-step divergence detection and repair |
| [`spec/core/targeting.md`](spec/core/targeting.md) | multi-locator targets that survive redesigns |
| [`spec/core/judgment.md`](spec/core/judgment.md) | three-layer evidence and deterministic verdicts |
| [`spec/core/trace.md`](spec/core/trace.md) | the versioned trace event contract |

## LLM backends

Set a key and cairn picks the backend. With no key at all, a local Claude Code install (the default fallback) or the OpenAI Codex CLI both work key-less.

| Backend | How it is selected |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Gemini | `GEMINI_API_KEY` |
| Claude Code | local install, no key (default fallback) |
| Codex CLI | local install, reuses your ChatGPT login |

Force one with `createLlmClient({ backend: "codex" })` or the `CAIRN_LLM_BACKEND` env var.

If your model is not supported, implement the `LlmClient` port or open an [issue](https://github.com/team-poem/cairn/issues/new/choose).

## Contributing

cairn takes pull requests. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow (Conventional Commits, an issue link per PR, the `spec/architecture.md` invariants).

## License

[MIT](LICENSE).
