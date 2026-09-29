---
issue: 259
pr: 260
status: in-progress
summary: Retain Chrome request evidence across navigation without moving step watermarks
next: Review and merge the driver fix after CI
---

MCP's preserved requests are a sliding window, not the cumulative log consumed by
step expectations and outcome-heal watermarks. The Chrome adapter now retains
observed rows by page ID and request ID for its session. New identities append;
status updates replace a slot without moving it. Returned evidence is copied so
later completion and consumer mutation cannot rewrite an earlier observation.

Collection at action/navigation boundaries also covers replays without per-step
expectations. Independent runs retain the suite's fresh-driver lifecycle; goto
cannot reset a multi-navigation run or invalidate the outcome-heal watermark.
The log is cleared on terminal close. This fix adds neither a reset API nor a
selector/model dependency.

The real #230 fixture failed before the fix after a successful order navigation.
It now passes its original POST and destination criteria, repairs v3's changed
control with one scripted call, and replays the repair in a fresh browser with
zero calls. Real-browser checks also retain evidence beyond the three-navigation
window, reject stale step evidence, update a pending response in place, isolate
popup identities and fresh sessions, and retain a genuine POST 500 through
outcome healing without returning a repaired scenario.

The log can retain only what MCP exposed before eviction. Missing responses are
not inferred from navigation or application state. MCP's finite retention and
console retention remain separate limitations. Memory grows with the driver
session, and action boundaries now make a network-list call. These tradeoffs and
the fresh-driver requirement are documented with the runnable regression.
