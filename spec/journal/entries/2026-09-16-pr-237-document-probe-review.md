---
issue: 231
pr: 237
status: in-progress
summary: Batch document probes and directly test observation guards
next: Review PR 237 with document continuity and global replay ordinals preserved.
---

# Document probe review

On `codex/231-document-refs`, address solp721's report of 79 MCP calls per
framed-page exact click and missing unit coverage for `chrome-documents.ts`.
Complete topology now groups perception fact probes by document before evaluation,
avoiding known mixed-frame failures and recursive rediscovery. Candidate order and
global index/nth remain unchanged; incomplete topology and detached UIDs retain
the existing isolation path.

Main-document targets still validate every captured document. Other frames can
change the global ordinal pool, and CSSOM/media changes can change accessibility
without a DOM mutation record. An unchanged revision therefore cannot replace a
fresh accessibility capture. The document guard implementation remains unchanged.

The new pure unit suite executes production guard scripts in separate VM document
contexts. Its 31 cases cover original objects, selected UID rebinding, harmless UID
rotation, empty frames, mutation locality, global accessibility drift, overflow,
malformed replies, closing revision races, and probe batching/fallback. The new API
batching assertion failed before implementation (three probes instead of two).
Six temporary guard weakenings each failed tests; bypassing validation entirely
failed 26 cases. All production mutations were restored. Existing tests are intact.

Real Chrome with pinned MCP 1.8.0 reproduced 79 calls before the change and 62 after
it at each of five click positions: evaluations fell from 63 to 46. The five-position
median perception-to-click time was 6.05 seconds before and 5.30 seconds after in
one local run per revision. This is an informational fixture measurement, not a
general latency guarantee. `scripts/measure-document-refs.mjs` runs the unchanged
fixture and reports per-tool counts and action timings for repeat measurements.
All five exact clicks, twelve lifecycle rejections, skill-file round trips, and
fresh-browser replay with zero LLM calls passed after the change.

Validation also passed typecheck, build, dependency boundaries, language and journal
checks, 1,204 engine tests, 183 benchmark contracts, and 30 browser tests. Independent
review found no remaining issues. State change: review feedback is implemented and
verified; PR 237 remains pending review and merge.
