---
issue: 231
pr: null
status: in-progress
summary: Preserve exact Chrome refs across guarded documents and global replay ordinals
next: Merge prerequisite PR 236, then review and land the document-reference follow-up in develop.
---

# Document reference follow-up

This completes item 3 of issue 231, following PR 236's work on items 1, 2 and 4.
It supersedes the earlier entry's decision to defer document-scoped guards. Public
Driver, Target and frozen Scenario shapes remain unchanged. Document tokens,
original frame owners and node identities stay inside the Chrome adapter.

Every captured document protects one globally ordered role cohort, including
unnamed empty frames. Guards are installed before the definitive capture. Frame
replacement, navigation, ownership or cohort drift expires references, and two
bounded validation intervals refuse continuously changing observations. A closing
revision sweep covers changes while other documents are evaluated; generation
checks prevent older captures and asynchronous page lookups from publishing stale
references. Separate browser contexts are not an atomic browser-wide transaction.

Real MCP output exposed shared virtual InlineTextBox UIDs. A separate structural
parser ignores these aliases while preserving the existing semantic parser and
compact replay ordinals. Missing child roots, unknown measurements and shadow
coverage still preserve candidates without exact references. MCP 1.8 can omit
loaded nested cross-site document trees, which remains unsupported coverage.

The regression suite retains all baseline tests and covers document lifecycle,
global duplicate order, original-node UID rebinding, harmless UID rotation and
asynchronous supersession. Independent review found and helped close two async
validation gaps. Engine, benchmark and browser suites pass with 1,173, 183 and
30 tests respectively, together with typecheck, build, boundaries and language.

The checked-in `test:document-refs` fixture and dedicated MCP 1.8 CI job reproduce
five exact clicks across main, same-origin nested and cross-site sibling documents,
public skill-file save/load and fresh-browser replay with zero LLM calls, and
twelve lifecycle rejections before click dispatch. Server-side click receipts
verify positive outcomes; tool-dispatch counts verify negative outcomes without
relying on the timing of asynchronous HTTP receipts.

Issue closure is appropriate after both PRs land in develop. This entry records
implemented and verified work, not a merge or release.
