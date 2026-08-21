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

That middle seat has a name now — **agentic testing**. cairn is its engine.

## See it

```console
$ cairn discover "log in and open the cart" --url=https://shop.example --freeze=cart.skill.json
discovering with anthropic:claude-sonnet-4-6 …

discovered scenario "log in and open the cart" — 6 steps:
  · {"kind":"goto","url":"https://shop.example"}
  · {"kind":"click","target":{"text":"Log in","role":"button","index":0},"intent":"submit the login form"}
  ⋮

frozen → cart.skill.json  (replay with: cairn replay cart.skill.json)

$ cairn replay cart.skill.json
replaying frozen skill "log in and open the cart" — deterministic, no LLM

log in and open the cart
  ✓ navigated → https://shop.example/cart
  · llm: 0 call(s)
  ✓ no-failed-requests
  ✓ request-status — 200 https://shop.example/api/auth

✓ pass — 3 assertion(s)
```

That second command is your regression suite: same input, same verdict, **zero LLM calls** — and
the report prints the proof itself (`· llm: 0 call(s)`; `result.usage` in the library). When a
redesign renames the login button, `--heal` repairs just that step and re-freezes:

```console
$ cairn replay cart.skill.json --heal --freeze=cart.skill.json
  · llm: 1 call(s) · 1184 in / 42 out tokens
✓ pass — 3 assertion(s)

self-healed 1 step(s):
  · "Log in" → "Sign in"
  re-frozen → cart.skill.json
```

## Use it

You need **Node ≥ 20**, **Chrome**, and a model — a provider key (`ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` / `GEMINI_API_KEY`), or no key at all with a local **Claude Code** or
**Codex CLI** install.

```sh
npm install cairn-engine
```

**Author once** — an AI discovers the flow; you freeze it to a file:

```ts
import { discover, ChromeDevToolsDriver, createLlmClient, saveSkillFile } from "cairn-engine";

const scenario = await discover(
  "log in, add the first product, open the cart",
  {
    driver: new ChromeDevToolsDriver(),
    llm: createLlmClient(), // Claude Code if installed, else ANTHROPIC_API_KEY
    baseUrl: "https://shop.example",
  },
);
await saveSkillFile("cart.skill.json", scenario);
```

**Replay forever** — deterministic, no LLM. When the UI drifts, `heal` repairs the step and you
re-freeze the fixed path:

```ts
import { runScenario, loadSkillFile, saveSkillFile } from "cairn-engine";

const scenario = await loadSkillFile("cart.skill.json");
const { result, healedScenario } = await runScenario(scenario, {
  heal: true, // repair a broken step with the LLM instead of going red
});

if (healedScenario) {
  // the UI changed and cairn adapted — write the repaired path back
  await saveSkillFile("cart.skill.json", healedScenario);
}
if (!result.verdict.passed) process.exit(1); // a deterministic gate for CI
// result.usage carries the cost proof: llmCalls is exact (0 on a clean replay),
// token totals whenever the backend measures them.
```

Prefer a one-off from the terminal? The same steps are CLI commands —
`cairn discover … --freeze cart.skill.json` · `cairn replay cart.skill.json` · `… --heal`.
Knobs: `discover --max-steps=N`, `replay --expect-timeout=ms`, and `discover --semantic` to
freeze LLM-judged `expect` checks too (replay then needs an LLM critic for those — off by default).

**Models** — set a key and cairn picks the backend: **Anthropic** (`ANTHROPIC_API_KEY`),
**OpenAI** (`OPENAI_API_KEY`), or **Gemini** (`GEMINI_API_KEY`). No key at all? A local
**Claude Code** install (the default fallback) or the **OpenAI Codex CLI** (reuses your ChatGPT
login) both work key-less. Force one with `createLlmClient({ backend: "codex" })` or the
`CAIRN_LLM_BACKEND` env var, or implement the `LlmClient` port for any other model.

## Survey, don't freeze — `cairn explore`

`discover` builds a test; `explore` files a report. Give it a **charter** and the same loop
wanders your app looking for what would annoy a real user — **failed requests**, **console
errors**, **dead controls** (a click that changed nothing), **action errors**, **slow settles**,
plus problems the exploring model itself records — nothing is frozen:

```sh
cairn explore "survey checkout and the account pages for UX problems" \
  --url=https://your.app --report=findings.md    # exit 1 on error-severity findings
```

From the library: `explore(charter, { driver, llm, baseUrl })` returns an `ExploreReport`;
`renderExploreReport(report)` renders the markdown.

## Run a whole case list — `cairn suite`

Hand cairn your QA cases — natural-language intents plus **your** success criteria — and it
verifies the lot: cached skills replay deterministically (**zero LLM calls**); misses are
discovered once, frozen with your criteria merged in, and replayed. A healed case is re-frozen so
the next run is clean again; a truncated discovery fails closed.

```sh
cairn suite cases.json --skills ./skills --report suite.md   # exit 1 if any case fails
```

From the library: `runSuite(cases, opts)` returns per-case verdicts + whole-suite LLM usage;
`renderSuiteReport(result)` renders the markdown summary.

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
      "expect": { "requestStatus": { "urlIncludes": "/auth", "status": 200, "method": "POST" } }
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

Each `target` keeps several locators — `text` (accessible name) first, with `nth` to address the
Nth of several identically-named elements (`{"text": "Accept", "role": "button", "nth": 2}` is the
3rd Accept button, 0-based), `role` + `index` as a rename-resilient fallback, `selector` as a CSS
escape hatch — which is what lets replay survive a redesign without falling back to the LLM. The `expect` on a step is its post-condition: replay
checks it deterministically and only heals if it diverges. Each frozen assertion also records its
`origin` — `user` (your own criterion) or `derived` (grounded by the engine from observed
evidence) — so a report can tell which greens were verified against *your* spec.

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
`ContextProvider` (auth/fixtures), `LlmClient` (any model). Discovery itself takes an
**`ActionPolicy`** — a deterministic gate that vets each proposed action before it runs, seeing
the page (current elements + URL), not just the proposal: block destructive controls, cap
wandering, stop on a goal. The same policy gates the unattended re-discovery when
`runScenario({ heal: true, policy })` repairs a broken flow. Discovery also takes a **`perceive`**
hook (a `PerceptionAdapter`) to correct the state of widgets that keep it outside the a11y tree —
a custom checkbox whose selection lives in a styled class, not `aria-checked` — so the model sees
the real state without the engine hacking app-specific DOM; `runScenario({ perceive })` threads it
into an outcome-heal re-discovery the same way. Too much for a full port? `custom`
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
  trace: { emit: (e) => timeline.push(e) }, // the full lifecycle as data (below)
});
```

The `trace` option (a **`TraceSink`**) turns the whole run into a versioned event stream —
discover decisions, gate firings (a policy block, an ambiguity refusal), steps, assertions
(each labeled `origin: user | derived` and by who judged it), heals with what-broke →
what-it-became — to watch live or store and replay in a viewer. Without a sink nothing is even
built, and a throwing sink can never change a verdict. Storing it is one import —
**`JsonlTraceSink`** writes each event as a JSONL line, screenshots as `seq`-keyed sidecars,
and survives a run that dies mid-way. Contract: `spec/core/trace.md` in the repo.

**Browser / extension (no Node)?** Import the browser-safe core from `cairn-engine/browser` and
compose `runHarness` with your own `Driver` (e.g. one over `chrome.debugger`) plus a fetch-based
`LlmClient`.

## Conventions

Name embedded files `*.agentic.ts` + frozen `*.skill.json` — distinct from `*.test.ts` /
`*.spec.ts`, stable glob `**/*.agentic.ts`.

**Full docs · design · the loop:** https://github.com/team-poem/cairn · MIT
