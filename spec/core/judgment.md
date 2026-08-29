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

## Fail closed — a verdict must not out-run its evidence

Three composition rules keep `verdict.passed` honest for the CI-gate use case:

- **No assertions → fail** (#69): an empty assertion set verifies nothing; `[].every` green is vacuous.
- **Blocked run → fail** (#90): assertions only prove evidence that was *collected*. If a step
  blocked (executed but its post-condition never held, or failed outright), the trailing steps never
  ran — assertions satisfied by the executed prefix must not read as a completed scenario. So
  `passed` requires *assertions hold AND every executed step ok*. `Verdict.detail` names the blocked
  step and its error, so a consumer can tell "run didn't finish" apart from "assertions failed".
  A *healed* step is recorded ok — self-heal, idempotent skip, and re-discovery are the sanctioned
  paths for "the step diverged but the goal is still reachable", not a passing verdict over a
  partial run.
- **All assertions vacuous → fail** (#137): at freeze, each derived assertion is evaluated against
  the *baseline* evidence (right after the entry goto, before any flow action); one the start
  already satisfies is stamped `vacuous` in the frozen data. A `request-status` hit is the
  strongest case — the request log only grows, so a check a landing-page request satisfied can
  never fail at replay. When *every* assertion carries the stamp, replay fails closed: a scenario
  that cannot go red proves nothing green. One discriminating assertion (including any
  suite-merged `origin: user` criterion, which is never stamped) keeps the verdict normal; the
  guards (`no-failed-requests`/`no-console-errors`) carry the stamp on a clean start but are not
  individually warned on — a flow action can still break them.

## Grounded — "a green run means it actually worked"

When discover proposes assertions, it **grounds them in what actually happened** (`deriveAssertions`):
- a proposed `request-status` is kept *only if a captured request matches it* (hallucinations dropped);
- `navigated` asserts the *right destination* (host+path) — catching "navigated, but to the wrong
  page." A segment the run minted is frozen as `*`, which matches exactly one segment, so an order
  id in a confirmation URL does not pin the check to that run; a destination whose path is nothing
  but wildcards is refused, since the app's error page would satisfy it. A literal `*` in a page's
  own path is read as a wildcard — the one place this notation is lossy.

→ This deterministically fills the weak default ("only `no-failed-requests` → passed but wrong").

## Perception's role (P6)

Three layers are *captured*, but the deterministic verdict rules on **two** — execution + logic.
`Evidence.perception.screenshot` is **not judged by built-in critics**; it feeds the host's visual
replay and is available to `custom` checks. LLM-vision assertions (a critic that reads the screenshot)
are a future step — the claim is "three captured, two judged", not "three judged".
