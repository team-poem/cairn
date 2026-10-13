---
issue: 196
pr: null
status: in-progress
summary: Reject numeric-looking extra array properties in custom contract inputs
next: Review the correction on PR 285 while no-merge remains in place
---

Strict custom-parameter canonicalization must verify that a numeric property is an
actual array index within `length`. Keys such as `4294967295` are ordinary properties
that a custom check can observe but array serialization omits. Their presence now
makes authored and replayed contract identities incomplete, so comparisons return
`unknown` while the original custom check and params remain usable.

Three boundary regressions failed before the guard and passed after it. A dense-array
control keeps ordinary indexed values complete and distinguishes changed contracts.
Validation passed: all 1,614 workspace/benchmark/demo tests, 41 focused contract tests
(included in that total), two real-Chrome contract tests, typecheck, build, dependency
boundaries, language, the consumer example, and independent diff review.

This entry records the correction only. The merge workflow remains responsible for
the full PR 285 journal entry, as requested by the PR's existing follow-up commit.
