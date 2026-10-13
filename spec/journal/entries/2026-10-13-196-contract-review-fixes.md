---
issue: 196
pr: null
status: in-progress
summary: Fix effective judgment context identity and preserve custom replay compatibility
next: Complete verification and review before committing the issue 196 implementation
---

Cross-review reproduced three gaps: effective semantic intent was not fingerprinted, unsupported
in-memory custom params aborted replay, and explicit undefined params could collide with absent
fields while producing different judgments.

Keep authoring intent separate from the actual Context.intent consumed by semantic/injected critics.
Capture the latter in ordinary replay and after outcome repair fetches context again. An unknown
effective intent cannot produce a complete semantic identity. Unrepresentable custom inputs instead
produce incomplete identity without changing custom handler input or execution. Strict standalone
hashing still rejects non-JSON values; custom params do not use its lossy undefined-field projection.

Regression tests first reproduced all three failures, then passed with the fixes. Coverage includes
renamed semantic scenarios, explicit and mutated context, browser entry-point pipeline execution,
fresh outcome-repair context, legacy custom params and nested explicit undefined fields.
