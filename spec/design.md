# design — pointer

- **Canonical (for agents):** `docs/design.md`
- **Visual version (for people):** `docs/design.html`
- **Core mechanism specs:** `spec/core/`

**One line:** a QA agent that explores an unfamiliar app to find a path (discover), freezes the
success path (freeze), and from then on replays it deterministically (replay). Judgment uses
three-layer evidence — execution · perception · logic. CLI-first in shape. The invariants the
code must keep: `spec/architecture.md`.
