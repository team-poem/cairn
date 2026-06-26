# spec — cairn specs (index)

> Where cairn's thinking lives, by role. Read the smallest doc that fits the task.

## Map

- **[architecture.md](architecture.md)** — the **invariants** the code must keep (enforced by a PR hook).
- **[design.md](design.md)** — pointer to the canonical product design (`docs/design.md`; visual `docs/design.html`).
- **[core/](core/)** — **core mechanism specs** (how the engine works and why):
  - [the-loop](core/the-loop.md) — discover → freeze → replay → self-heal; economics · determinism · the flexibility dial.
  - [judgment](core/judgment.md) — three-layer evidence judgment.
  - [targeting](core/targeting.md) — multi-locator + freeze stability.
  - [surgical-heal](core/surgical-heal.md) — per-step outcome verification + surgical self-heal.
- **[journal/](journal/)** — **current state · dev log** (Korean, internal): [state](journal/state.md) · [history](journal/history.md).

## Roles (don't duplicate across them)

- `architecture.md` = the rules. `core/` = *why* those rules, and *how* the mechanism implements them.
- `docs/design.md` = the product pitch (for readers). `core/` = engineering precision (types · paths · pitfalls).
- `journal/` = what changed and when. Everything else = how things should be.
