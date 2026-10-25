---
issue: 305
pr: null
status: in-progress
summary: Compose separate engine calls and host work under one workflow budget
next: Open the pull request and set pr in this entry
---

# Compose separate engine calls and host work under one workflow budget

## What

`runWorkflow({ budget, signal? }, work)` owns one allowance, deadline and cancellation signal.
Inside `work`, `workflow.borrow(name)` issues a lease. `discover`, `explore`, `runHarness` and
`runScenario` borrow it through `workflow: lease`, and host-owned model and browser work opts in
through `lease.llm`, `lease.driver` and `lease.operation`. Both the Node and the browser entry
points export it. The contract is in `spec/core/run-budget.md` under "Workflow composition".

Internally, the run budget is split into a shared `Allowance` (count, deadline, signal, in-flight
operations, lifecycle stage) and a per-participant `BudgetScope` (phase, evidence, actions,
usage). An owned run still has exactly one scope, so existing calls and per-case suite budgets
behave as before.

## Why these choices

- **The internal scope class is not exported.** A lease exposes only borrowing operations, so a
  borrower cannot reset or dispose the owner. This is what the issue asked for.
- **A borrowed call throws on exhaustion instead of returning a budget verdict.** The host's
  composition stops at the participant that ran out, so verification cannot start after a
  preparation that was stopped. The owner returns the single stop result.
- **One engine operation per lease.** Each participant's evidence and uncertain operation then
  belong to that call alone.
- **Double-counting is prevented by identity.** The allowance remembers every wrapper it makes and
  unwraps before wrapping again. A lease client hidden inside a foreign wrapper cannot be
  recognized, and the spec says so rather than guessing with async context.
- **No owner cleanup callback.** `runWorkflow` returns only after all admitted work has settled,
  so ordinary host cleanup after it returns already runs once, with nothing in flight.
- **`runSuite` does not borrow.** Suite cases keep independent allowances, as #284 decided.
