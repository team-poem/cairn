# 2026-09-11 — release PR #207 benchmark baseline availability

- Branch: `codex/207-benchmark-baseline`, based on develop `224d03c`.
- Cause: release PR #207 compares develop to main `4ba1e07`. Runs 34503171953
  and 34498166960 both failed importing `baseline/bench/local/runner.mjs`.
  The base commit contains no local benchmark harness. This was a CI rollout
  assumption, not observed engine performance degradation or a browser flake.
- Fix: inspect the exact base Git tree. An absent local harness yields a
  separate size-only schema and report, with exact SHAs, build hashes, dirty
  flags, actual npm-pack and browser bundle bytes and explicit replay
  unavailability. No replay times, pass counts or LLM usage are fabricated.
- Existing partial/broken trees, invalid ancestor paths, deleted checkout files,
  toolchain/import/discovery/measurement failures still fail. Once the base has
  the harness, the ordinary paired comparison runs without configuration changes.
- Publisher: only a successful eligible workflow can publish size-only data.
  Strict schema validation rejects malformed sizes/SHAs and mixed replay fields.
  Existing fork, stale-SHA, bot-identity and full-replay guards remain intact.
- Verification: 1,164 workspace tests plus 136 benchmark/publisher tests pass
  (1,300 total). Ten new regressions cover the real coordinator/npm pack, absent
  and malformed baselines, actual runner failure and publisher behavior. Existing
  tests are unchanged. Typecheck, build, boundaries and actionlint pass.
- Real baseline check: main `4ba1e07` and the updated checkout were built and
  compared successfully without MCP. The raw result is at
  `/tmp/cairn-207-main-comparison-2`: package tarball 158451 → 214810 bytes,
  browser gzip 16419 → 23219 bytes. These span all main/develop changes, not
  this CI fix alone; the local head is explicitly dirty. No replay was measured.
  An initial pack invocation hit sandbox npm-cache EPERM; a temporary cache
  resolved it without changing cache ownership or repository permissions.
- Independent review found no blocking issue and identified the invalid ancestor
  path edge case; its added regression failed before the guard and passed after.
- State change: prepare a focused fix PR against develop. Merging that fix into
  develop updates #207 and reruns its benchmarks. No release branch merge,
  default-branch change, release or manual review comment was performed.

## Reflection

- Brain: unchanged (root harness restrictions).
- Skills: unchanged.
- Structural: availability is tested against the named commit and represented
  explicitly, separately from both measured success and measurement failure.
- Todos: the fix still needs maintainer review/merge into develop before #207
  benefits; no root backlog files were edited.
