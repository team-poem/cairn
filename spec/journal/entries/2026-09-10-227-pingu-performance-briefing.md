# 2026-09-10 — pingu-cairn performance briefings

- Branch/PR: `codex/220-ci-performance`, #227. The user requested that the
  existing pingu-cairn GitHub App brief performance results, and confirmed that
  `CAIRN_BOT_CLIENT_ID` / `CAIRN_BOT_PRIVATE_KEY` are its existing credentials.
- Change: the trusted benchmark publisher creates a repository-scoped App token
  with pull-request write permission. Artifact discovery/download retain the
  read-only workflow token. No App credential reaches the PR measurement job.
- Author ownership: resolve the token action's App slug to a verified Bot user;
  only comments with that numeric user ID and the benchmark marker are updated.
  Existing stale-commit and run-attempt checks remain in force.
- Presentation: a deterministic briefing summarizes tarball/browser-gzip deltas,
  observed tier medians, passed attempts and measured LLM calls. Full comparison
  tables and provenance are expandable. Invalid tiers have no speed claim;
  shared-runner timing is explicitly informational. No LLM summarizes the data.
- Verification: comparison regressions and mocked publisher/briefing checks
  cover mixed effects, failed/LLM-tainted tiers, fork association, stale data,
  failed workflows and ownership by numeric bot ID. Typecheck, build, all 1,141
  tests, actionlint and an independent permissions/security review passed.
  No manual comment was sent.
  The token action's documented `app-slug` identity mechanism and existing
  repository triggers were reviewed; comments do not retrigger these workflows.
- State change: #227's automated author is now the confirmed existing App. The
  default-branch rollout prerequisite remains. The previously observed Windows
  journey failure is separate from this publisher change and remains unresolved.
- Reflection: bind mutable reports to the authenticated author's immutable ID,
  and derive both the briefing and full table from one validated comparison.
  This is encoded in the publisher; no root brain/skill files were changed.
