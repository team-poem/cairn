# cairn-engine

![cairn banner](https://raw.githubusercontent.com/team-poem/cairn/main/banner.svg)

[![npm](https://img.shields.io/npm/v/cairn-engine.svg)](https://www.npmjs.com/package/cairn-engine)
[![CI](https://github.com/team-poem/cairn/actions/workflows/ci.yml/badge.svg)](https://github.com/team-poem/cairn/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/cairn-engine.svg)](https://www.npmjs.com/package/cairn-engine)
[![license](https://img.shields.io/npm/l/cairn-engine.svg)](https://github.com/team-poem/cairn/blob/main/LICENSE)

**An AI writes your browser test once — then it runs forever with no AI at all, and heals itself when the UI changes.**

An AI walks your app **once** to discover the flow and **freezes** it. From then on it replays
**deterministically — no LLM, no hand-written selectors.** When the UI changes and a step breaks,
the AI returns to **heal just that step**, then re-freezes. A third thing, between two tools you
already reach for:

- **Scripted (Playwright/Cypress)** — deterministic, but you hand-write selectors that break every redesign.
- **LLM agents** — plain language, but a slow, costly, flaky model in _every_ run.
- **cairn** — plain-language authoring **and** deterministic, free, self-healing replay.

## Use it

```sh
npm install cairn-engine
```

**Author once** — an AI discovers the flow; you freeze it to a file:

```ts
import { discover, ChromeDevToolsDriver, createLlmClient } from "cairn-engine";
import { writeFileSync } from "node:fs";

const scenario = await discover(
  "log in, add the first product, open the cart",
  {
    driver: new ChromeDevToolsDriver(),
    llm: createLlmClient(), // Claude Code if installed, else ANTHROPIC_API_KEY
    baseUrl: "https://shop.example",
  },
);
writeFileSync("cart.skill.json", JSON.stringify(scenario, null, 2));
```

**Replay forever** — deterministic, no LLM. When the UI drifts, `heal` repairs the step and you
re-freeze the fixed path:

```ts
import { runScenario, loadSkillFile } from "cairn-engine";
import { writeFileSync } from "node:fs";

const { result, healedScenario } = await runScenario(
  loadSkillFile("cart.skill.json"),
  {
    heal: true, // repair a broken step with the LLM instead of going red
  },
);

if (healedScenario) {
  // the UI changed and cairn adapted — write the repaired path back
  writeFileSync("cart.skill.json", JSON.stringify(healedScenario, null, 2));
}
if (!result.verdict.passed) process.exit(1); // a deterministic gate for CI
```

Prefer a one-off from the terminal? The same steps are CLI commands —
`cairn discover … --freeze cart.skill.json` · `cairn replay cart.skill.json` · `… --heal`.

**Models** — set a key and cairn picks the backend: **Anthropic** (`ANTHROPIC_API_KEY`, or a local
**Claude Code** install with no key), **OpenAI** (`OPENAI_API_KEY`), or **Gemini**
(`GEMINI_API_KEY`). Force one with `createLlmClient({ backend: "openai" })`, or implement the
`LlmClient` port for any other model.

## How the loop works

```
intent ─► discover (LLM, once) ─► cart.skill.json ─► replay (no LLM, forever)
                                                          │ a step breaks
                                                          ▼
                                                  self-heal (LLM, just that step)
```

- **discover** _(LLM · once)_ — observes the live page, picks one action, acts, and repeats until your intent is met. Out comes a `Scenario`.
- **freeze** — that scenario is plain JSON (`*.skill.json`): a flat list of steps + assertions, each target carrying several locators. No model, no LLM — just data.
- **replay** _(no LLM)_ — runs the steps through a `Driver`, auto-waiting for the page to settle; a `Critic` rules on three layers of evidence — _did it act_ · _what it looked like_ · _the requests & console_. Same input, same verdict.
- **heal** _(LLM · only on a break)_ — when a target stops resolving or the outcome diverges, the LLM maps your original step `intent` onto the new page, repairs that one step, retries, and returns a scenario to re-freeze. A green replay never calls it.

Discovery is paid once; regression is free. A frozen scenario is data you can read, diff, and edit
by hand:

```json
{
  "name": "cart",
  "steps": [
    { "kind": "goto", "url": "https://shop.example" },
    {
      "kind": "type",
      "target": { "text": "Email" },
      "text": "you@shop.example"
    },
    {
      "kind": "click",
      "target": { "text": "Log in" },
      "intent": "submit the login form",
      "expect": { "requestStatus": { "urlIncludes": "/auth", "status": 200 } }
    },
    { "kind": "click", "target": { "text": "Add to cart" } },
    { "kind": "click", "target": { "text": "Cart", "role": "link" } },
    { "kind": "waitFor", "until": { "url": "/cart" } }
  ],
  "assertions": [
    { "kind": "navigated", "to": "/cart" },
    { "kind": "no-failed-requests" }
  ]
}
```

Each `target` keeps several locators — `text` (accessible name) first, `role` + `index` as a
rename-resilient fallback, `selector` as a CSS escape hatch — which is what lets replay survive a
redesign without falling back to the LLM. The `expect` on a step is its post-condition: replay
checks it deterministically and only heals if it diverges.

**Measured, not claimed** — a real multi-step checkout, via cairn's `bench/` harness:

- **4/4 deterministic** replays · **0 LLM calls** on replay
- discovery **~$0.50 once** → every replay after is **$0** (a full LLM agent runs **~$15–30 _per run_**)
- a renamed button broke hand-written selectors; cairn **healed it and stayed green**

## Build on it

cairn is the machinery — discover · freeze · replay · heal — behind a handful of ports, **general
in mechanism, specific in meaning.** It's made to be **built on**, not scattered across your
service as test code. A few things it powers:

- **A QA tool** — non-developers write flows in plain language, then watch them replay & self-heal
- **A CI regression gate** — frozen flows run on every PR; drift heals instead of going red
- **A synthetic monitor** — replay critical paths against production, alert only when one truly breaks
- **A visual-replay app** — the engine streams per-step progress + screenshots; you draw the UI

You _can_ call `runScenario` straight from a test file — nothing stops you. But that isn't the
point: cairn is **not a Jest or Playwright you write service tests in** — it's the engine those
kinds of tools are built _from_. Reach for it to **build** testing tooling, not to author a test
suite by hand.

## Extend it

The core knows no app — **you** supply what "success" means and how to drive the browser. Every
stage is a replaceable port — your own `Driver` (e.g. Playwright), `Critic`, `Reporter`,
`ContextProvider` (auth/fixtures), `LlmClient` (any model). Too much for a full port? `custom`
assertions/actions define success inline:

```ts
await runScenario(scenario, {
  custom: {
    "cart-has": (p, ev) =>
      ev.logic.requests.some((r) => r.url.includes(p.path) && r.status === 200),
  },
});
```

Building a UI on top? The engine streams exactly what a screen needs — wire it up and draw:

```ts
const controller = new AbortController();
await runScenario(scenario, {
  signal: controller.signal, // a Stop button
  screenshots: true, // a PNG per step
  onStep: (s) => render(s.index, s.step, s.ok, s.screenshot), // a live timeline
});
```

**Browser / extension (no Node)?** Import the browser-safe core from `cairn-engine/browser` and
compose `runHarness` with your own `Driver` (e.g. one over `chrome.debugger`) plus a fetch-based
`LlmClient`.

## Conventions

Name embedded files `*.agentic.ts` + frozen `*.skill.json` — distinct from `*.test.ts` /
`*.spec.ts`, stable glob `**/*.agentic.ts`.

**Full docs · design · the loop:** https://github.com/team-poem/cairn · MIT
