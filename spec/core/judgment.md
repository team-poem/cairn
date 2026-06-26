# Judgment — three-layer evidence

## Principle

cairn **does not judge by "the screen looked right."** It judges on observable facts in *three layers* — pressing the chronic AI-QA failure (*false pass*) down with evidence.

## Three-layer evidence (`Evidence`)

- **execution** — did it actually act/navigate. `{ actions, navigated, finalUrl, blocked }`
- **perception** — what it looked like. `{ screenshot }` (per step)
- **logic** — requests & console. `{ requests[{method,url,status}], console[{type,text}] }`

## Assertions (`Assertion`) — three kinds, one dispatch

- **mechanical** — `navigated{to}` · `no-failed-requests` · `no-console-errors` · `request-status` → **deterministic (no LLM).**
- **`expect`** — a natural-language criterion, **judged by an LLM** (`LlmCritic`). Opt-in via `--semantic` / `semanticChecks`. If present, replay calls the LLM → so it is **not put in the default freeze** (preserves determinism, invariant #4). None present → zero LLM.
- **`custom`** — defined by the product (`{kind:"custom",name}` + a host handler). *The product decides what "success" means.*

Routing = `AssertionHandler.supports() → judge()` dispatch — no branching inside a stage (invariant #2). The two critics (`AssertionCritic`/`LlmCritic`) differ only in *which handlers they register*.

## Grounded — "a green run means it actually worked"

When discover proposes assertions, it **grounds them in what actually happened** (`deriveAssertions`):
- a proposed `request-status` is kept *only if a captured request matches it* (hallucinations dropped);
- `navigated` asserts the *right destination* (host+path) — catching "navigated, but to the wrong page."

→ This deterministically fills the weak default ("only `no-failed-requests` → passed but wrong").

## Perception's role (P6)

Three layers are *captured*, but the deterministic verdict rules on **two** — execution + logic.
`Evidence.perception.screenshot` is **not judged by built-in critics**; it feeds the host's visual
replay and is available to `custom` checks. LLM-vision assertions (a critic that reads the screenshot)
are a future step — the claim is "three captured, two judged", not "three judged".
