---
issue: 252
pr: null
status: in-progress
summary: Report app context PoC results from an internal Cairn-based QA extension
next: Review the results report; any format or API decision remains separate
---

The PoC ran in the existing internal QA extension. Keep this change limited to
its anonymized results: no local demo, benchmark implementation, main README
promotion or engine changes.

The six retained discoveries used 48 calls without extra context and 43 with it.
All twelve raw replays executed every step with zero model calls; eleven passed
with work proof. Report the unresolved console failure, fixed condition order,
incomplete history, manual resets, missing product/quantity oracle and unknown
dollars alongside the findings. The experiment is concluded; no new runs are
scheduled and no app-context format or API is adopted.
