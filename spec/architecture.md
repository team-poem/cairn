# cairn architecture invariants

cairn is a QA agent that turns natural-language intent into browser actions and judges the
result on collected evidence. The full design is in `docs/design.md` (visual: `docs/design.html`),
and the core mechanisms in `spec/core/`. This document holds **only the invariants the code
must keep**.

## Structure
- Execution body = a pipeline: **Context → Plan → Execute → Judge → Report.**
- Monorepo: `packages/harness` (engine) + `packages/qa` (app).

## Invariants (must not be violated in a PR)

1. **Pattern ≠ data.** `packages/harness` depends on no specific domain's/environment's code,
   data, or connectors. Environment-specific behavior is injected only via interface
   implementations (plugins).
2. **Extend through interfaces only.** New behavior is added through one of these interfaces —
   `ContextProvider · Planner · Driver · SkillStore · Critic · Reporter`.
   Do not branch directly inside a pipeline stage.
3. **The loop is only in discovery.** The agent loop (observe · act · adapt) runs only when
   *exploring an unfamiliar app*. Executing a defined scenario is the pipeline.
4. **Replay is deterministic.** A frozen scenario's replay path has no LLM. The LLM is called
   only to (a) discover a new scenario, or (b) self-heal a broken skill.
5. **Model/driver agnostic.** The core is not hard-wired to a specific LLM or browser. The
   default driver is Chrome DevTools MCP, replaceable (Playwright, etc.).
6. **Dependency direction.** `qa → harness`, one way. `harness` never imports `qa`.

## Checklist when touching the core
- [ ] harness imports no specific domain/environment code
- [ ] new behavior added via an interface (no direct branch in a stage)
- [ ] no LLM call on the replay path
- [ ] dependency direction (qa → harness) preserved
