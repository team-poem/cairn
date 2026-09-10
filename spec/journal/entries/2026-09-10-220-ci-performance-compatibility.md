# 2026-09-10 — PR measurements and OS compatibility

- Branch: `codex/220-ci-performance`, from develop `01378e3`. The user expanded
  #220 from separate test reporting to actual per-PR comparisons and OS checks,
  then approved the implementation plan and nine failing comparison tests.
- Changes: separate workspace/offline bench test commands while preserving the
  local aggregate; compare exact base/head package and browser bundle bytes,
  plus three local replay tiers; run native build/browser compatibility on
  Ubuntu, macOS and Windows. Node filesystem cleanup replaces `rm -rf` in the
  engine build command. Existing engine algorithms and tests are unchanged.
- Measurement: baseline fixture/runner/scripted discovery produces shared
  canonical captures; both public built engines warm up and alternate over three
  rounds with fixed delays. Failures, incomplete samples and unknown/nonzero
  replay LLM usage invalidate the comparison. Timing remains informational.
  Raw attempts, hashes, dirty state and tool versions are preserved.
- Reporting: Actions summary and artifacts plus a separate trusted
  `workflow_run` comment publisher. It recomputes from validated JSON, checks
  current PR SHAs and bot ownership, and never executes PR artifact code with a
  write token. Artifact names include the run attempt: a failed rerun cannot
  reuse earlier successful measurements. The comment workflow activates only
  after reaching the default branch; its absence does not remove the summary.
- Verification: nine approved tests were appended verbatim through TDD; all
  1,063 workspace tests and 78 offline benchmark tests passed. Typecheck, build,
  dependency boundary, actionlint and the official Sobaya gate passed. All 71
  pre-existing test/fixture files are byte-identical to the base. Seven real Chrome probe
  tests passed on macOS. Native scripted discovery and replay passed all three
  tiers. A full local paired measurement passed 18/18 measured replays plus six
  warmups, with zero engine-reported/observed replay LLM calls. This was a dirty
  local tooling verification on Node 26/Chrome 153, not a hosted-CI performance
  claim. Linux/Windows and hosted Node 20 await actual GitHub execution.
- Review: separate read-only refutation found fresh-output-parent handling and
  worker-exit/rerun-artifact failure semantics; those are fixed. npm 12's object
  form of pack JSON is accepted alongside npm 10's array. Mocked publisher
  checks cover fork association, stale head/base/run suppression, invalid data,
  failed warmups/workflows and bot-only updates without sending any comments.
- State change: implementation of the expanded #220 scope is ready locally.
  No push, issue/PR message, merge, branch-protection change or paid LLM call was
  made. Larger reliability/provider-cost measurements remain #169/#214.
- Reflection: preserve attempt identity across artifact consumption; distinguish
  declared commit from dirty workspace state; use native Node paths for OS
  coverage. These are encoded in the new tooling and docs. Harness brain/skills
  remain unchanged under the root maintenance restriction.
