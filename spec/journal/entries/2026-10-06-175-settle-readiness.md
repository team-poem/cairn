---
issue: 175
pr: 281
status: in-progress
summary: Wait for network and DOM quiet with explicit background request exclusions
next: Review PR 281 and confirm CI before merging into develop
---

Chrome settling now measures current MCP request identities, response transitions and literal
pending rows alongside document mutations. A separate expiring observer retains only a revision
and leaves exact-reference guards intact. The same deadline bounds tool calls and sleep. Evicted
pending evidence stays unknown without holding the current wait open indefinitely.

Application-specific polling arrives through `ChromeDriverOptions.settle.ignoreRequests`, with
per-call overrides. These URL substrings affect idle accounting only: excluded requests remain
cumulative evidence and can still fail assertions. They do not become benign failures. Snapshot
lookup caches are cleared after waiting so deferred rendering is visible to later lookup.

The committed public-driver fixture reproduces the original pending-fetch and DOM races and
checks polling exclusions, an unrecovered 503, the mutation cap and a server-verified zero-call
replay. On one local comparison against develop 31cfed0, with a 400ms quiet interval, baseline
settle returned in 423ms while the fetch was pending; the fix waited 2764ms through the response
and deferred rendering. Excluded polling took 543ms versus 2212ms. These are fixture observations,
not population latency estimates. Reproduce with `npm run build && npm run test:settle` and the
runner's optional `--baseline-engine` argument. CI preserves the fixture's JSON result.

Typecheck, build, full tests, boundaries, language and diff checks passed, as did all 30 Chromium
probe/reference tests and the real MCP 1.8.0 document-reference and cumulative-network regressions.
No hosted model was used. Settling remains a bounded heuristic; missing DOM measurements fall
back to network waiting, and response headers do not prove body completion. CSS-only, frame or
shadow rendering and work scheduled beyond the quiet window still require `expect` or `waitFor`.
