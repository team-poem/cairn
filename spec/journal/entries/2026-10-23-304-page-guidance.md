---
issue: 304
pr: null
status: in-progress
summary: Bind host page guidance to the observation a discovery or exploration decision uses
next: maintainer review of the contract in spec/core/page-guidance.md before opening a pull request
---

# Bind host page guidance to the observation a decision uses

`discover` and `explore` accept an optional `pageGuidance` provider. It is called once per decision
observation, after capture, `perceive`, selection and reference issuance, and before the decision
prompt. It sees only the listed rows (role, name, ordinal, three states) and a URL read just before
capture. Its text goes into a separately labeled host section of that one prompt.

The decisions that carry weight:

- **Invalidation is a pre-dispatch URL comparison, not an atomic read.** A guided decision whose
  page URL changed before dispatch is not run. Same-URL changes rely on the existing observation
  identity and reference validation; guidance relaxes neither.
- **Fail open, but never on cancellation.** Provider errors, a 5-second timeout, non-string or
  oversized output (over 4,096 UTF-8 bytes, never truncated) mean no guidance for that decision.
  Caller cancellation and the run deadline still reject the run. Provider time counts against the
  run deadline through the existing budget operation, without a model-call admission.
- **Guidance cannot author checks or identity.** Assertion proposals and judgment never receive it.
  Inline assertions from a guided `done` are discarded. Scenario, provenance, contract and cache keys
  are unchanged.
- **Repair paths and `runSuite` are out of scope** for this change; replay never calls the provider.

Trace moves to 1.12 for `gate: page-guidance`, which carries fixed reasons only.
