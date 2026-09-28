---
issue: 246
pr: 261
status: in-progress
summary: Match action guidance to the current observation reference table
next: Review and merge PR 261
---

Discovery, exploration, and surgical step healing select reference guidance from the
current validated table, rather than the driver's optional locateRef capability.
Empty, absent, or entirely filtered tables receive named-target schemas and retain
role/ordinal disambiguation. Reference-enabled prompt text remains unchanged.
Forged refs still fail binding; parsing, fallback, and retry budgets are unchanged.

The regression suite covers changing reference availability and named execution.
All 1,218 workspace tests and 183 benchmark/script tests passed, as did typecheck,
build, boundaries, and language checks. The reproducible real-Chrome fixture in
bench/local/reference-free.mjs saved the expected form value through discovery,
exploration, and step healing, then replayed with zero model calls. Its scripted
responses validate the contract, not hosted-model decision quality.
