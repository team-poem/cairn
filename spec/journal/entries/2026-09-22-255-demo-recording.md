---
issue: 255
pr: 258
status: in-progress
summary: Record and verify the six-stage order demo using the existing engine
next: Choose hosting, test the example with newcomers, and update the main README entry points
---

The sample shop and viewer stay in an example using public engine interfaces.
The recording preserves the exact installed engine archive, source hashes,
browser screenshots, traces, original assertions, and a separate order oracle.
No engine behavior or app-context input was changed.

A complete local recording with codex:gpt-5.6-sol observed 7 discovery calls,
0 healthy replay calls, 0 calls for the expected broken-target replay, 1 verified
repair call, 0 repaired-replay calls, and 7 calls while attempting to repair an
application defect. Both healthy replays carry work-grade proof. The failed order
remains red and no replacement scenario is offered.

The initial order-500 assertion survives in the trace, while the final request
list after outcome re-discovery is empty. The recorder checks the initial
mechanical failure and final unchanged goal separately; the viewer discloses the
missing final evidence. This is related evidence for the network-retention work
requested in discussion 238, not proof of a shared cause or a driver fix.

Earlier discoveries confused same-name text labels with inputs. The small demo
prefills its sample email and exposes the name input once in the accessibility
tree. The README records this limitation and the unsuccessful preparation runs;
the demonstration does not establish general discovery or repair reliability.

Repository typecheck, build, boundaries, language, and tests passed. The complete
recording is generated and ignored, not hand-edited into a successful result.
Deployment and external-user validation remain outstanding.
