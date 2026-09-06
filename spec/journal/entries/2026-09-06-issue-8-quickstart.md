# Issue 8 — standalone tarball quickstart

- Branch: `codex/8-quickstart`, based on develop `94ee94e`.
- Applied architecture invariants: environment behavior stays in the consumer; public ports only;
  caller owns each fresh driver; replay stays LLM-free. Judgment proves POST success, beyond arrival.
- Added `examples/quickstart`: its own npm/pnpm manifest, local SPA form fixture, TypeScript agentic
  runner, generated bare Scenario, and acceptance verifier. Scripted discovery drives real Chrome
  with four LlmClient responses, then FileSkillStore freezes/loads and replay runs twice.
- Deliberately broken POST returns 500 while the SPA still reaches /success. The request-status
  assertion fails and exits 1. Invalid/missing skills exit 2; fixture cleanup is verified by rebinding.
- Added external tarball consumer test: npm/pnpm installation, public types, actual installed CLI
  statuses 0/2/1, browser-platform esbuild bundle without Node externals, and actual Chrome quickstart.
  CI runs npm and pnpm 10 separately on Node 20. esbuild becomes a direct dev dependency at its
  existing lockfile version; no unrelated dependency updates.
- RED evidence: consumer runner failed ENOENT for the absent quickstart manifest before implementation.
  Initial full-document navigation dropped MCP current-page POST evidence; fixture uses ordinary SPA
  pushState navigation, documented in its README. No engine behavior changes were made here.
- Validation: app typecheck/build; 41 test files / 915 existing tests; external npm and pnpm 10 consumer
  checks; generated sample from actual scripted Chrome discovery then freeze. Live paid-model
  discovery is documented and intentionally not executed.
- State change for develop after merge: issue 8 now has a standalone installable consumer and CI
  proof of the current packaged engine. CLI/internal boundary changes are the companion work.
