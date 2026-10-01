---
issue: 248
pr: null
status: in-progress
summary: Keep missing custom evidence out of pass proof and app failures
next: Review inconclusive aggregation and repair withholding
---

Custom checks can explicitly abstain with an inconclusive result and a detail.
Judged checks determine mixed verdicts and only judged evidence contributes proof.
An entirely inconclusive run fails closed as an unverified script, not an app
regression. Inconclusive evidence does not initiate outcome healing and cannot
authorize re-freezing a repair. The trace reason is additive in version 1.8;
console output labels abstentions separately. Existing custom returns remain valid.
