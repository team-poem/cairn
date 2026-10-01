---
issue: 241
pr: null
status: in-progress
summary: Demonstrate discovery policy rejection with a real browser and scripted client
next: Review the standalone ActionPolicy example
---

The quickstart includes a public-API example that proposes a forbidden deletion,
rejects it through ActionPolicy, and then saves a record. It verifies driver dispatch
and server state independently, plus grounded save evidence. The fixture and browser
are caller-owned and cleaned up on success and failure. The narrow policy demonstrates
discovery enforcement only; it does not interpret arbitrary prose or promise replay
or heal coverage. Scripted completions require no model account.
