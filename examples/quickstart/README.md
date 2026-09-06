# Standalone cairn quickstart

Copy this directory anywhere and install it independently. The runner imports only the published
`cairn-engine` API; it needs no workspace links, source checkout, or engine edits.

## Prerequisites

- Node **20.19+ on 20.x, 22.12+ on 22.x, or 23+** (required by Chrome DevTools MCP).
- Google Chrome installed in its normal location. Each run launches an isolated headless browser.
- npm, or pnpm 10. Keep local port **127.0.0.1:4318** free and run one quickstart process at a time.
- Network access for dependency installation and the first `npx chrome-devtools-mcp@~1.3.0` launch.
- No model account or API key for the scripted path below.

## Install → discover → freeze → replay

From this directory, choose one package manager:

```sh
npm install
npm run discover:scripted
npm run freeze
npm run replay
```

```sh
pnpm install
pnpm run discover:scripted
pnpm run freeze
pnpm run replay
```

`discover:scripted` supplies four fixed responses through the public `LlmClient` port: type `Cairn`
into `Name`, click `Submit`, finish with a POST success assertion, and propose the final assertions.
The **real Chrome driver** locates and acts on the local fixture, and discovery grounds the assertion
against captured traffic. This proves API integration and repeatability, **not a real model's ability
to discover an unfamiliar flow**. It reports `DISCOVERED: scripted calls=4` and writes
`.artifacts/discovered.json`.

`freeze` reads that discovered Scenario, persists `submit.skill.json` with `FileSkillStore.freeze`,
and checks `FileSkillStore.load` round trips the same data. The checked-in `submit.skill.json` was
produced by this actual scripted discovery and freeze command; regenerate it rather than editing it.

`replay` loads the frozen skill and runs it **twice, with fresh browser instances**. Both must report:

```text
PASS: replay 1/2; llmCalls=0; attemptedLlmCalls=0
PASS: replay 2/2; llmCalls=0; attemptedLlmCalls=0
```

The engine's measured call count and a throwing LLM stub independently verify zero calls. Healing
is disabled. The fixture and caller-owned browser are closed in `finally` after each run.

## Make it fail

```sh
npm run replay:broken
# or: pnpm run replay:broken
```

The fixture uses SPA navigation (`history.pushState`) so Chrome retains the POST evidence in its
current-page request log. The fixture now responds **500** to `POST /api/submit` but still visits `/success`. The frozen
`request-status` assertion fails, so reaching the success page cannot produce a false green:

```text
FAIL: request-status POST /api/submit expected 200; observed 500; reached /success; llmCalls=0
```

Expected exit codes: **0** for successful commands, **1** for a failing replay verdict (including the deliberately broken replay),
**2** for setup/input errors or failed example invariants. A missing or malformed skill prints
`ERROR: Cannot load skill …` with recovery commands and still releases the fixture. For example:

```sh
npm run replay -- missing.skill.json
# pnpm run replay missing.skill.json
```

`npm run verify` (or `pnpm run verify`) checks the complete workflow, both passing replays, the
intentional failure's evidence and exit code, invalid JSON/invalid Scenario/missing files, and port
release. `npm run typecheck` checks the public TypeScript API usage.

## Discover with a real model (optional)

```sh
# Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY in your shell first.
npm run discover
npm run freeze
npm run replay
# pnpm: replace "npm run" with "pnpm run"
```

This command calls `createLlmClient()` and sends the intent and browser observations to the selected
model; it can incur model usage costs. API keys select Anthropic, then OpenAI, then Gemini.
Alternatively, `CAIRN_LLM_BACKEND=codex` uses an installed, authenticated Codex CLI, and
`CAIRN_LLM_BACKEND=claude-code` uses Claude Code (the default when no key is set).
The runner rejects incomplete discovery or a missing grounded POST proof. Real discovery may take
more calls and is **not run in CI**. The fixture, store, and replay code are otherwise the same.

## What CI proves

The repository builds and packs the current engine, copies this directory into an external temporary
folder, and installs that **tarball** with npm and pnpm separately. It typechecks this consumer, runs
the installed `cairn` executable (exit 0/2/1), bundles `cairn-engine/browser` for the browser without
externalizing Node dependencies, and runs `verify`. The manifest here deliberately stays on the
published `cairn-engine@^2.8.0`; only the temporary CI copy substitutes the current tarball.
