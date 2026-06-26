# Cairn — design

> A QA agent: describe what you want in plain language, the AI finds that path in the browser
> once and saves it, and from then on it replays the same path **with no AI**, judging pass/fail
> on the evidence it collects.

cairn is not the AI itself but **the engine wrapped around it** — what goes in as context, how it's
driven, and what it's judged on.

- **Identity:** an embeddable **engine** (`cairn-engine`, npm). Not a CLI product. The CLI is just one
  thin consumer; a desktop QA app is a separate project that installs it.
- **Agnostic:** not tied to a specific LLM or browser. The default driver is Chrome DevTools MCP.
- **Status:** `cairn-engine@1.0.0` released (npm) · 54 tests · MIT.

> Reader-friendly visual version: [`docs/design.html`](./design.html). Engine internals and benchmark
> numbers live in a separate "cairn-engine engine doc." This `.md` is the canonical design.
> Core mechanism specs: [`spec/core/`](../spec/core/).

---

## 1. Design invariants

The five constraints the engine keeps — defined in `spec/architecture.md` and enforced by a PR hook.

- **Pattern ≠ data** — `core/` knows no specific app/environment. Environment-specific behavior is
  injected only via port implementations.
- **Extend through ports only** — new behavior is added via an interface; no branch inside a stage.
- **The loop is only in discovery** — the observe·act·adapt loop runs only when *exploring an unfamiliar app*.
- **Replay is deterministic** — a frozen scenario's replay path has zero LLM. Same result every time.
- **Model/driver agnostic** — both the LLM and the browser driver sit behind interfaces. Replaceable.

The execution body is a pipeline; the loop is used only on an "unfamiliar app."

---

## 2. Requirements → structure

The parts were derived backwards from what QA actually needs.

| What QA needs | The part it requires |
|---|---|
| Knows nothing about the target app | context injection (fit intent to the real screen) |
| Must unfold intent into steps | scenario generation (Plan) |
| Must click like a human | a driver (browser tooling) |
| Can't pre-plan a path for an unfamiliar app | the discovery loop (look · click · look again) — *the only loop* |
| Pages are slow or dynamic | auto-wait that waits for loading to settle |
| Judge right/wrong on evidence | evidence collection + a Critic |
| Must not pay AI cost on repeat runs | save the success path (freeze) → replay |
| Success criteria differ per product | product-defined custom assertions |

Most of it is an ordered pipeline; the loop is required only on an "unfamiliar app."

---

## 3. Architecture · pipeline

The execution body is a five-stage pipeline. Hexagonal — `core/` (domain + ports) ↔ `adapters/` (implementations).

```
Context → Plan → Execute → Judge → Report
```

`Execute` has an auto-wait that waits until page loading settles (until the network goes quiet) — so a
late-rendering screen doesn't cause a wrong failure.

---

## 4. The core bet — discover and replay

There's only one uncertain point — **an unfamiliar app.** If you don't know the screen, you can't
pre-plan where to click. So the first run is **discovery**: look → click → look at the changed screen → decide next.

```
discover:  intent + unknown app  →  ↻ look·click·look again  →  path found   (AI loop, ~$0.5 once)
                                     ↓ freeze (save JSON)
replay:    saved scenario         →  run it again as-is                       (no AI · deterministic · ~4s · $0)
self-heal: broken by UI change    →  AI repairs it; onHeal flags "aging"       (exception, only when it breaks)
```

You keep the AI's flexibility but drop the AI cost and flakiness of paying it every run. The AI steps
back in for only two things — (a) discovering a new path, (b) repairing a broken one (self-heal).

> Measured: real multi-step flow replay **4/4 deterministic · 0 AI · ~4s** · discover **$0.4–0.6 once**
> (vs $15–30/run for a full agent) · UI rename **survival 0→4/4** (self-heal AI 2→0).

---

## 5. Extension points — the product defines them

Each pipeline stage is a replaceable port. The core holds default implementations and prompts; a
specific environment just implements the ports and plugs them in.

```ts
interface ContextProvider { provide(task): Context }   // NL · git diff · ticket · RAG
interface Planner         { plan(ctx): Scenario }      // intent → steps
interface Driver          { goto·click·type·locate·observe·close() } // default ChromeDevTools MCP / swap Playwright
interface SkillStore      { resolve(name): Scenario }  // freeze / replay storage
interface Critic          { judge(evidence, asserts) } // mechanical | LLM | product-defined
interface Reporter        { emit(result) }             // console · json · any tracker
interface LlmClient       { complete(prompt) }         // Claude Code · Anthropic · BYO
```

Even the closed data is open — the product defines **success criteria** and **interactions** directly:

```ts
await runScenario(scenario, {
  custom:  { "cart-has": (p, ev) => ev.logic.requests.some(r => r.url.includes(p.path) && r.status === 200) },
  actions: { "drag-slider": async (driver, p) => { /* product-specific interaction */ } },
})
```

**The boundary = pattern vs data.** We own the loop, ports, and good defaults (pattern); the product
owns the specifics (actions, assertions, locators, context, scenario assets). What ships open-source is
the engine; domain assets stay in the product.

---

## 6. Evidence and judgment

Three observable layers are captured. The deterministic Critic rules on two — execution and logic;
the perception layer (per-step screenshots) feeds the host's visual replay and is available to custom
checks, with LLM-vision assertions a future step — never "the screen looked right".

```ts
Evidence = {
  execution:  { actions, navigated: true, finalUrl, blocked: false },  // execution layer
  perception: { screenshot: "data:image/png;…" },                     // visual layer (per step)
  logic:      { requests: [{ url: "/api/orders", status: 500 }],       // logic layer
                console:  [{ type: "error", text: "orders is null" }] }
}
```

Assertions are fit **to what actually happened, not to an AI guess** — if it really navigated, the
*right* destination (host+path) is checked; failed requests are always absent (harmless ones like a
favicon excluded). "What success is" is the product's via `custom` assertions; an ambiguous goal goes
through `expect` (AI judgment, optional).

> Next (unimplemented): **known-item suppression** — if the input (change summary, ticket) says "this is
> intentionally not applied," filter it out as a non-bug. Press the chronic AI-QA false-positive down
> with input context.

---

## 7. Product shape

One engine, three entrances.

**① Embed (recommended) + CLI · CI — now.** `import` the engine or use the CLI. Replay needs neither AI nor a key.

```
$ cairn discover "log in, add the first product, open the cart" --url shop.example --freeze cart.json
→ 6 steps · frozen → cart.json
$ cairn replay cart.json            # deterministic, 0 AI
✓ navigated → /cart.html  ✓ no-failed-requests  ✓ pass · exit 0
```

**② Desktop QA app — next (project 2).** The engine already exposes display seams — `onStep` (timeline) ·
`screenshots` (per-step PNG) · `signal` (Stop) · `onHeal` (aging notice). The **UI is not put in the
engine**; a separate app installs `cairn-engine` and renders it — a visual replay over a logged-in
browser session that a non-developer can watch.

```ts
class MyContextProvider implements ContextProvider { /* git diff · ticket → Context */ }
class MyReporter        implements Reporter        { /* result → any tracker */ }

await runScenario(scenario, { context: new MyContextProvider(), reporter: new MyReporter() })
```

---

## 8. Where it is, and where it's going

| Stage | Content |
|---|---|
| **✓ engine v1.0** | discover→freeze→replay→self-heal · 7 ports + custom extension · 3-layer evidence · multi-locator · desktop seams · bench-verified · npm released. |
| **next · product** | desktop QA app (scenario management · visual replay · suites · history) — layered on top of the engine. |
| **next · input/CI** | git diff · ticket ContextProvider, GitHub Action PR gate, known-item suppression. |
| **1.x · engine hardening** | broader LLM backends (OpenAI, etc.) · testid locators · deterministic semantic assertions · broader bench. |

Most QA tooling is work layered **on top of the engine** (management, orchestration, history), not
changes to the engine — that's how the engine/app boundary is drawn.

Monorepo: `packages/harness` (the engine = `cairn-engine`) + `packages/qa` (planned). MIT licensed.
The invariants the code must keep: [`spec/architecture.md`](../spec/architecture.md).
