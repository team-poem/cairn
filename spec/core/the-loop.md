# The core loop — discover → freeze → replay → self-heal

## One line

Describe what you want in plain language; the AI finds that path **once** and freezes it; from then on it replays the path **with no LLM**, judging pass/fail on the evidence it collects. When it breaks, the AI returns **only then** to repair it.

## Four stages

- **discover** — the LLM observes, acts, and adapts its way through an *unfamiliar app* to find a path. The agent loop lives **only here** (invariant #3). It produces an *intent (`reason`)* for every action. An optional **`ActionPolicy`** (injected, invariant #2) gates each proposed action before it runs — a consumer can block destructive/irreversible controls, cap wandering, or stop on a goal, all app-agnostically (the engine offers the seam; the rules come from the host). Absent → every action runs (unchanged).
- **freeze** — the discovered path is hardened into a deterministic asset (`Scenario`). Targets are stored by *intent* (multi-locator), not by handle → see [targeting](targeting.md).
- **replay** — the frozen path runs with **zero LLM** (invariant #4). Same result every time.
- **self-heal** — when a step diverges at replay, the LLM repairs **just that step** and re-freezes (convergence). No break → no LLM. See [surgical-heal](surgical-heal.md).

## Why this shape — the LLM is expensive and non-deterministic

So the LLM is used **only for authoring (discover) and repair (heal)**; **repetition (replay) stays deterministic and free.**

- **"LLM once, free thereafter":** discovery is paid once (~$0.5); replay is $0. Regression runs every time at zero cost.
- **Determinism:** a frozen path is identical every run → trustworthy and repeatable (invariant #4).

## Where it bets — the determinism ↔ flexibility dial

| | Scripted (Playwright/Cypress) | LLM agents | **cairn** |
|---|---|---|---|
| Authoring | selectors & code | natural language | natural language |
| Every run | deterministic, cheap | LLM in the loop — slow, costly, flaky | deterministic, cheap (LLM-free) |
| UI changes | you fix selectors | re-reasons (may drift) | **self-heals, then re-freezes** |
| LLM calls | 0 | every run | once to discover + *only when it breaks* |

cairn's seat = **flexible at authoring/repair + deterministic at repetition.** The *one* sweet spot between pure scripting (zero flexibility) and LLM agents (costly, untrustworthy every run).

## Resolving the core tension (→ surgical-heal)

Pure `freeze→replay` **assumes a static state** → it breaks on stateful/dynamic apps (already logged in, state branches). So the **precision** of "LLM only when needed" is the crux: only *the step that diverged* must be repaired, surgically, so determinism and flexibility hold **at the same time**. This is the last gate to top marks → [surgical-heal](surgical-heal.md).

## Invariants (summary — canonical in `architecture.md`)

deterministic replay · loop only in discovery · pattern ≠ data · extend through ports only · model/driver agnostic · dependency direction qa→harness.
