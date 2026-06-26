# cairn-engine

![cairn banner](https://raw.githubusercontent.com/team-poem/cairn/main/banner.svg)

The engine behind [cairn](https://github.com/team-poem/cairn) — an AI walks an unfamiliar
app **once** to discover a browser test and **freezes it into a marker**; from then on it
replays that path **deterministically, with no LLM in the loop**. When a step breaks or lands
in the wrong state, the LLM returns to **heal** just that step, then re-freezes. **Discovery is
paid once; every replay is free.** Model- and browser-agnostic — embed it, or drive it from the `cairn` CLI.

```sh
npm install cairn-engine
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
import { runScenario } from "cairn-engine";

const { result } = await runScenario(scenario, { heal: true });
if (!result.verdict.passed) process.exit(1);
```

Building a UI on top? The engine exposes the seams; you bring the UI:

```ts
const controller = new AbortController();
await runScenario(scenario, {
  signal: controller.signal,                 // a Stop button
  screenshots: true,                         // capture a PNG per step
  onStep: (e) => render(e.index, e.step, e.ok, e.screenshot), // live timeline
});
```

Make it yours — the engine ships defaults, your product defines the specifics:

```ts
await runScenario(scenario, {
  // success is whatever your product says it is
  custom: { "cart-has": (p, ev) => ev.logic.requests.some((r) => r.url.includes(p.path) && r.status === 200) },
  // product-specific interactions, beyond click/type/hover/select/scroll
  actions: { "drag-slider": async (driver, p) => { /* … */ } },
});
```

Every layer is replaceable: bring your own `Driver` (e.g. Playwright), `Critic`, `Reporter`,
`ContextProvider` (auth / fixtures), or `LlmClient` (any model) — and use `custom`
assertions / `actions` for what doesn't fit the built-ins. Nothing forces your product
through only what we decided.

**Browser or extension (no Node)?** `runScenario` and the default Chrome DevTools MCP driver
need Node. Import the browser-safe core from `cairn-engine/browser` and compose `runHarness`
with your own `Driver` (e.g. one over `chrome.debugger`) plus a fetch-based `LlmClient`:

```ts
import { runHarness, StaticPlanner, AssertionCritic, AnthropicLlmClient } from "cairn-engine/browser";
```

No API key needed if you have **Claude Code** installed (cairn shells out to it); set
`ANTHROPIC_API_KEY` to use the Anthropic API instead.

**Full docs, design, and the loop diagram:** https://github.com/team-poem/cairn

MIT
