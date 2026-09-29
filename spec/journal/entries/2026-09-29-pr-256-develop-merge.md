---
issue: null
pr: 256
status: in-progress
summary: Merge develop while preserving secret validation and target-choice exclusion
next: Confirm CI and complete review of PR 256
---

Merged current develop into the opt-in Jev pilot branch. The runScenario entry
point retains both eager secret validation from develop and the pilot check that
rejects simultaneous targetChoice and legacy heal configuration. The screenshot
consumer guard remains intact.
