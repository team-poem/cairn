---
issue: 304
pr: null
status: in-progress
summary: Validate guided decisions against page changes and prepare the page-guidance PR
next: Review and merge the page-guidance pull request into develop
---

# Complete the page-guidance decision boundary

This entry supersedes the review-next-step in `2026-10-23-304-page-guidance.md`; the maintainer
requested implementation and PR preparation. The original entry remains an unchanged record.

Accepted guidance is checked before any decision effect, including completion and exploration
notes. Reference-free decisions compare a fresh semantic/perception snapshot with state copied
before the provider ran, so same-URL overlays and even an in-place mutation of a Driver-returned
array invalidate old guidance. Exact-reference actions retain the Driver's mutation guard;
recapturing would rotate their references. URL checks bracket the comparison capture, but this
is an observation-boundary check, not an atomic lock or a claim that invisible/reverted changes
can be detected.

Rebased onto the current `develop` while preserving per-run action-policy lifecycle and
no-progress completion semantics. Trace 1.13 adds the fixed page-guidance diagnostics after
1.12's no-progress changes. Raw comparison state and guidance are never new trace fields.

Verification passed:

- Typecheck and build.
- Full tests: 1,611 workspace tests, 397 benchmark/script tests and 8 demo tests.
- Dependency boundaries, English-only repository check, journal validation and clean diff checks.
- Public Node/browser exports and a browser-platform bundle.
- Real Chrome with MCP 1.8.0: two guided observations across page navigation, exact-node click,
  three discovery/proposal model calls, then successful frozen replay with zero model calls.
  Reproduce after building with `node scripts/test-page-guidance.mjs`; `CAIRN_MCP_ENTRY` may select
  an installed MCP 1.8.0 entry point. The script supplies its own local page and scripted model.

The first sandboxed test run could not create tsx's local IPC pipe. The unchanged full test suite
passed with local IPC permitted; this was an execution-environment failure, not a test change.
