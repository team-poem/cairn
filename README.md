# cairn

![cairn banner](banner.svg)

A **cairn** is a stack of stones that marks a trail — built once, so the path can be found again. This tool does the same for browser tests: an AI walks an unfamiliar app once to find the path, **freezes it into a marker**, and from then on follows it **deterministically** — no LLM, no flakiness. When the trail shifts and a marker no longer fits, the AI **rebuilds it**.

cairn is the engine, not a product: a model- and browser-agnostic core (`@cairn/harness`) you run from the CLI or embed in your own app. You describe a QA flow in plain language; cairn discovers the steps, replays them cheaply forever, and heals them when the UI changes.

## The loop

The whole idea is one loop. The LLM is expensive and non-deterministic, so it runs **once** — to discover. Everything after is a cheap, repeatable replay; the LLM only returns when a step actually breaks.

```
  intent (plain English)
        │
        ▼
   discover ──────────────► skill.json ──────────► replay ──────► verdict
   observe · act · adapt      (frozen marker)      no LLM ·        3-layer
   (LLM, once)                                     deterministic   evidence
                                                      │
                                          a step breaks (UI changed)
                                                      ▼
                                                 self-heal
                                          LLM maps the intent onto the
                                          new UI, retries, re-freezes
```

## Why cairn

It sits in the gap between two things people already reach for — and don't love:

|                        | Scripted (Playwright / Cypress) | LLM browser agents          | **cairn**                                |
| ---------------------- | ------------------------------- | --------------------------- | ---------------------------------------- |
| Authoring              | hand-written selectors & code   | natural language            | natural language                         |
| Every run              | deterministic, cheap            | LLM in the loop — slow, costly, flaky | deterministic, cheap (LLM-free replay) |
| When the UI changes    | you fix the selectors           | re-reasons, may drift       | **self-heals, then re-freezes**          |
| LLM calls              | none                            | every run                   | once to discover · again only to heal    |

You don't maintain selectors, and you don't pay an LLM on every CI run. Discovery is paid once; regression is free.

## Quickstart

```sh
npm install -g @cairn/harness   # provides the `cairn` CLI
```

```sh
# 1. discover — an LLM walks the app and writes a scenario
cairn discover "from the example page, follow the link to learn more" \
  --url https://example.com --freeze checkout.json

# 2. replay — deterministic, no LLM; exits non-zero on failure (CI gate)
cairn replay checkout.json

# 3. heal — when a frozen step breaks, repair it and re-freeze
cairn replay checkout.json --heal --freeze checkout.json
```

The LLM backend needs no API key if you have **Claude Code** installed (cairn shells out to it); set `ANTHROPIC_API_KEY` to use the Anthropic API instead. The default browser driver is **Chrome DevTools MCP**, launched automatically.

Embed it instead of shelling out — every stage is an injected interface:

```ts
import {
  runHarness, StaticPlanner, ChromeDevToolsDriver,
  AssertionCritic, JsonReporter, InlineContextProvider,
} from "@cairn/harness";

const result = await runHarness({
  context:  new InlineContextProvider(),
  planner:  new StaticPlanner(scenario),   // replay a frozen scenario
  driver:   new ChromeDevToolsDriver(),    // or your own Driver
  critic:   new AssertionCritic(),         // or LlmCritic, or your own
  reporter: new JsonReporter("report.json"),
}, scenario.name);
```

## How it works

The execution body is a five-stage pipeline. No environment- or domain-specific logic lives inside it — every variable behavior arrives through one of six interfaces.

```
Context ─► Plan ─► Execute ─► Judge ─► Report
```

- **Context** — assembles grounding (the intent; later: git diff, ticket, docs)
- **Plan** — turns intent into a `Scenario` (an explicit one for replay; an LLM loop for discover)
- **Execute** — drives the browser, auto-waiting for the page to settle
- **Judge** — a **Critic** rules on three layers of evidence, not a screenshot guess:
  `execution` (did it act/navigate) · `perception` (what it looked like) · `logic` (requests, console)
- **Report** — emits the result anywhere (console, JSON, your tracker)

The six extension points — **`ContextProvider · Planner · Driver · SkillStore · Critic · Reporter`** — are how you adapt cairn without forking it. The LLM lives behind its own seam (`LlmClient`), so neither a model nor a browser is hard-wired into the core.

Two design lines hold the whole thing together:

- **Replay is deterministic.** A frozen scenario replays with no LLM in the loop. The LLM is summoned only to (a) discover a new scenario or (b) self-heal a broken one.
- **Pattern, not data.** The core knows no specific app or environment; everything app-specific is a plugged-in interface implementation.

## Structure

Ports & adapters (hexagonal): `core/` is the pure domain and the ports; `adapters/`
implements them. Dependencies point inward — adapters depend on core, never the reverse.

```
cairn/
├── packages/
│   └── harness/                  # @cairn/harness — the engine
│       └── src/
│           ├── core/             # domain + ports (depends on nothing else)
│           │   ├── types.ts        # Context · Scenario · Evidence · Verdict …
│           │   ├── ports.ts        # the extension points (interfaces)
│           │   ├── pipeline.ts     # Context → Plan → Execute → Judge → Report
│           │   └── discover.ts     # the LLM discover loop (the only loop)
│           ├── adapters/         # port implementations (the things you plug in)
│           │   ├── drivers/        # ChromeDevTools (MCP) · self-heal · fake
│           │   ├── critics/        # deterministic assertions · LLM
│           │   ├── reporters/      # console · json
│           │   ├── llm/            # Claude Code · Anthropic · factory
│           │   └── context/ · planners/ · skills/
│           ├── run.ts            # composition: runScenario with defaults
│           ├── index.ts          # public API
│           └── cli.ts            # thin CLI over the library
├── docs/design.md               # the design, in full
└── spec/                        # architecture invariants + living state
```

## Status

The full loop — **discover → freeze → replay → self-heal** — works today, driven by Chrome DevTools MCP, with deterministic and LLM critics. Next: input sources (git diff / ticket `ContextProvider`s), and a separate desktop app that embeds this engine for visual replay.

It is early. The interfaces are the contract; expect the surface around them to keep moving.

## License

MIT.
