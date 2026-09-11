<div align="center">
  <img alt="cairn banner" src="https://raw.githubusercontent.com/team-poem/cairn/main/banner.svg">
  <p>An AI writes your browser test once. It replays forever with no AI at all, and heals itself when the UI changes.</p>
</div>

# cairn-engine

Agentic-testing engine and CLI for the browser, written in TypeScript.

[![npm](https://img.shields.io/npm/v/cairn-engine.svg)](https://www.npmjs.com/package/cairn-engine)
[![CI](https://github.com/team-poem/cairn/actions/workflows/ci.yml/badge.svg)](https://github.com/team-poem/cairn/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/cairn-engine.svg)](https://www.npmjs.com/package/cairn-engine)
[![license](https://img.shields.io/npm/l/cairn-engine.svg)](https://github.com/team-poem/cairn/blob/main/LICENSE)

cairn turns a browser task into a reusable JSON test. Use the CLI, or embed `cairn-engine` in your own QA tools with your choice of model and browser driver.

![Claude — cumulative calls finish at 42 versus 7 per model. Dashed discovery line connects known endpoints only; intermediate counts are unavailable.](https://raw.githubusercontent.com/team-poem/cairn/main/docs/benchmarks/228-claude-calls.svg)

![Codex — Sol, Terra and Luna each show cumulative discovery calls of 7, 14, 21, 28, 35, 42, while discovery plus replay stays at 7.](https://raw.githubusercontent.com/team-poem/cairn/main/docs/benchmarks/228-calls.svg)

- **Journey:** The user flow being tested, such as login → cart → order.
- **Discover:** AI performs the task and creates the steps to replay.
- **Replay:** Run the saved steps again without LLM calls.
- **Heal:** AI repairs a step that broke after a UI change. This did not occur in these measurements.

Each table shows the total cost and LLM calls for six runs of the same journey, using each approach.

**Claude reported costs**

The [original measurements](https://github.com/team-poem/cairn/pull/228), priced by Claude Code at API list rates, including its helper model.

| Model | Journey | Discover every run | Discover once + replay |
| --- | --- | ---: | ---: |
| Sonnet 5 | Navigation | $0.109 · 18 calls | $0.018 · 3 calls |
| Sonnet 5 | Form save | $0.151 · 24 calls | $0.025 · 4 calls |
| Sonnet 5 | Login → cart → order | $0.269 · 42 calls | $0.046 · 7 calls |
| Opus 5 | Navigation | $0.208 · 18 calls | $0.030 · 3 calls |
| Opus 5 | Form save | $0.255 · 24 calls | $0.042 · 4 calls |
| Opus 5 | Login → cart → order | $0.463 · 42 calls | $0.077 · 7 calls |

**Codex estimated costs**

| Model | Journey | Discover every run | Discover once + replay |
| --- | --- | ---: | ---: |
| GPT-5.6 Sol | Navigation | ~$0.8002 · 18 calls | ~$0.0880 · 3 calls |
| GPT-5.6 Sol | Form save | ~$0.6905 · 24 calls | ~$0.0826 · 4 calls |
| GPT-5.6 Sol | Login → cart → order | ~$1.1513 · 42 calls | ~$0.1502 · 7 calls |
| GPT-5.6 Terra | Navigation | ~$0.2540 · 18 calls | ~$0.0391 · 3 calls |
| GPT-5.6 Terra | Form save | ~$0.1935 · 24 calls | ~$0.0313 · 4 calls |
| GPT-5.6 Terra | Login → cart → order | ~$0.3788 · 42 calls | ~$0.0566 · 7 calls |
| GPT-5.6 Luna | Navigation | ~$0.0276 · 18 calls | ~$0.0020 · 3 calls |
| GPT-5.6 Luna | Form save | ~$0.0297 · 30 calls | ~$0.0042 · 4 calls |
| GPT-5.6 Luna | Login → cart → order | ~$0.0407 · 42 calls | ~$0.0049 · 7 calls |

Compare the two approaches within each row. These fixtures do not establish a model price or quality ranking, and the dollar figures are not extra subscription charges. [Methods, token counts, and calculation](https://github.com/team-poem/cairn/blob/main/docs/benchmarks/228-codex.md).

When button names changed, the saved scenarios still found them by role and position. No AI repair was needed, so the cost and success rate of self-heal remain [unmeasured](https://github.com/team-poem/cairn/issues/230).

## Features

- Discover a flow from a plain-language intent, with an LLM, once
- Freeze it to a flat, readable, diffable `*.skill.json` file
- Replay it deterministically, with zero LLM calls, and print the proof (`llm: 0 call(s)`)
- Self-heal a broken step from its recorded intent, then re-freeze
- Fill `{name}` secrets at run time, scoped to your site, never frozen into a skill
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
npm install cairn-engine        # as a library
npm install -g cairn-engine     # as a CLI
```

## Usage

- as a [CLI](https://github.com/team-poem/cairn/blob/main/docs/guide.md#try-it-in-60-seconds)
- as a [library](https://github.com/team-poem/cairn/blob/main/docs/guide.md#embed-it)
- a standalone [npm/pnpm quickstart](https://github.com/team-poem/cairn/tree/main/examples/quickstart) with discovery, freeze, and zero-LLM replay

```sh
cairn discover "log in and open the cart" --url=https://your.app --freeze=cart.skill.json
cairn replay cart.skill.json            # deterministic; exit 1 flow broke · 3 script aged · 4 environment (retry, or fix the setup)
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
| [`docs/guide.md`](https://github.com/team-poem/cairn/blob/main/docs/guide.md) | the user guide: CLI, library, suites, explore, skill files, traces, extension points, FAQ |
| [`docs/design.md`](https://github.com/team-poem/cairn/blob/main/docs/design.md) | the full design, end to end |
| [`spec/core/the-loop.md`](https://github.com/team-poem/cairn/blob/main/spec/core/the-loop.md) | why discover, freeze, replay, heal |
| [`spec/core/surgical-heal.md`](https://github.com/team-poem/cairn/blob/main/spec/core/surgical-heal.md) | per-step divergence detection and repair |
| [`spec/core/targeting.md`](https://github.com/team-poem/cairn/blob/main/spec/core/targeting.md) | multi-locator targets that survive redesigns |
| [`spec/core/judgment.md`](https://github.com/team-poem/cairn/blob/main/spec/core/judgment.md) | three-layer evidence and deterministic verdicts |
| [`spec/core/trace.md`](https://github.com/team-poem/cairn/blob/main/spec/core/trace.md) | the versioned trace event contract |
| [`spec/core/secrets.md`](https://github.com/team-poem/cairn/blob/main/spec/core/secrets.md) | `{name}` secrets: filled at run time, scoped to a site, never frozen |

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

cairn takes pull requests. See [`CONTRIBUTING.md`](https://github.com/team-poem/cairn/blob/main/CONTRIBUTING.md) for the workflow (Conventional Commits, an issue link per PR, the `spec/architecture.md` invariants).

## License

[MIT](https://github.com/team-poem/cairn/blob/main/LICENSE).
