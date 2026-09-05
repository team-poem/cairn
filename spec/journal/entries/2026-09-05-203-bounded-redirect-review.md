# Issue #203 review — bounded redirects and remaining evidence limits

Branch: `codex/203-freeze-redirect`, PR #205.

## Review correction and decision

An advisory alone left the concrete 400ms response-to-redirect race unmitigated. The absence of a
navigation-completion signal limits guarantees, but does not justify skipping a bounded mitigation
that catches short redirects. The fix now combines bounded observation with the existing fallback
provenance marker; neither replaces the other.

Final observation shares its existing 2-second polling budget between pending flow mutations and
a completed, non-benign, same-site mutation whose step's pre-action URL still names the current
host+path. Request-tail attribution lives in one helper shared by waiting and marking. Trailing
non-mutation steps preserve the boundary. Query/hash progress updates do not count as a destination
change; a dedicated regression first reproduced that early-exit hole. The observed raw URL remains
unchanged. When a different URL appears, another bounded settle/observation collects its evidence.
Every continuation yields a capped polling sleep; continuously changing URLs cannot hot-loop and
starve timers. Remaining time reaches `Driver.settle`, and the pending request watermark is retained.

Outcome-heal was omitting the consumer's `benign` options when calling discovery. Forwarding that
existing option keeps the new wait's exclusions consistent with fresh discovery and prevents
incidental successful mutations from becoming step proofs during repair.

`SuiteVerdict.observedBeforeLastMutation` and `freeze.payload.observedBeforeLastMutation` contain
the distinct marked destinations, as an optional `string[]` absent when no assertion is marked.
Fresh/cached suite results, `onCase`, outcome-heal re-freeze, CLI progress, Markdown and JSON results
all retain it. Assertions remain the source of truth; no duplicate Scenario field was added.
Outcome-heal preserves the original goal assertions and their metadata, so a repair's discarded
derived assertions cannot introduce or remove the summary. Trace header version is now **1.3**.

The type, judgment/trace specs and CLI explicitly state that the marker alone must not become a
failure gate without additional evidence: a correct on-page save legitimately consumes the budget
and carries the advisory. Existing verdict, request proof and step-expect semantics are retained;
the better final observation can now ground a later destination and its expect.

## Verification

- Added **25 tests in three new files**. The public delayed
  400ms redirect, query/hash progress redirect, missing suite summary, and outcome-heal benign
  propagation each failed before its production fix and passed afterward.
- Coverage includes pending-to-success-to-redirect, budget expiry/on-page save, excluded traffic,
  trailing and latest qualifying request-tail boundaries, remaining settle/sleep time, late
  responses, continuously changing URLs, fresh/cached/healed summaries, original assertion
  preservation, absence when unmarked, `onCase`, CLI progress, Markdown and JSON output.
- `npm run typecheck` and `npm run build`: passed.
- Full `npm test` with local IPC available: **901 tests passed in 41 files**. The initial run's
  sole failure was the existing literal trace version assertion expecting `1.2`. With the user's
  explicit narrow exception, only its title and expected version were updated to `1.3`, matching
  the new trace contract. No other existing test line or assertion was changed.
- `git diff --check`: passed.
- The coordinating agent reproduced the original failure in actual Chrome and verified the new
  behavior: 400ms delayed redirect froze `/dashboard` unmarked; 4000ms delayed redirect froze
  `/signin` marked, then the browser later reached `/dashboard`; an immediate query/hash progress
  update followed by a 400ms redirect also froze `/dashboard` unmarked. These use an injected
  Playwright-backed Driver and scripted LLM, not the production Chrome MCP adapter.

## Limits and state change

This is a cooperative observation budget, not a strict wall-clock guarantee across driver RPCs.
Very late redirects and later hops after a different destination is observed remain unverified.
The wait compares concrete host+path; the advisory uses the consumer's locale/wildcard matcher,
so a changed resource path can still carry weaker generalized destination evidence. Request tails
are temporal attribution, and same-site background mutations still require the consumer's benign
seam. Existing step-expect attribution through a trailing scroll/wait remains unchanged.

After merge, record #203 as bounded redirect mitigation plus fallback advisory and trace/suite
surfacing. The advisory does not fail replay. `spec/journal/state.md` remains unchanged on this
work branch.
