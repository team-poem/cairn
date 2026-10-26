# Shared execution budgets (#284)

Optional runtime admission controls, not a new execution loop. The existing Driver and model
ports are decorated; deterministic replay stays model-free. Limits never enter a Scenario,
caseHash, or judgment-contract fingerprint.

## Existing controls audited

| Existing mechanism | What it bounds | Relationship to the shared budget |
|---|---|---|
| Discovery `maxSteps` (default 20), explore (40) | Decisions in one loop | Still applies; assertion proposals are additional calls |
| Three consecutive policy refusals | Repeated blocked proposals | Unchanged; cannot renew the run allowance |
| Surgical `MAX_STEP_HEALS` (5) | Repair attempts | Still applies alongside the shared allowance |
| Replay `expectTimeoutMs` (2 seconds), waitFor, driver settling | One post-condition/operation | Still applies; not a whole-run deadline |
| Discovery final observation polling | Evidence collection after actions | Still bounded locally; driver calls also check the deadline |
| HTTP timeout (60 seconds), two retries | One transport attempt and transient failures | Run signal cancels fetch/body/backoff; retries stay inside one admission |
| Claude Code / Codex subprocess timeout (120 seconds) | One child process | Run cancellation additionally kills the direct child |
| Jev target selection timeout (5 seconds) | One separate selection request | Same run admission and signal; no fallback |
| `UsageMeter` | Observed calls/tokens, not enforcement | Retained; reservation is a pre-dispatch check |
| Caller `AbortSignal` | User stop, previously checked between steps | Composed with deadline, retaining the first cancellation reason |

## API and boundaries

`budget?: { maxModelCalls?: number; timeoutMs?: number }` is accepted by `discover`, `explore`,
`runHarness`, `runScenario`, and `runSuite`. Omission preserves the existing path. Values must
be nonnegative safe integers; `timeoutMs` is additionally capped at 2147483647 (timer range).
Zero calls permits healthy mechanical replay; zero time permits no run work. An empty budget
has no numeric limit. Options are copied before asynchronous work.

- `discover` / `explore`: entry through the final returned scenario/report, including assertion
  proposals and contract computation. The caller owns its injected driver and cleanup.
- `runHarness`: context, plan, replay, judgment, contract computation. The caller owns the driver.
- `runScenario`: preparation, replay, all repair layers, original-goal rejudgment and owned-driver
  cleanup. A returned repair must complete inside this boundary.
- `runSuite`: a new scope per case, before cache load, through discovery, freeze, fresh-driver
  replay, repair, final freeze and owned-driver cleanup. Those phases borrow the same scope.
  No suite-wide quota. Suite preparation and `onCase` notifications are outside it.
- Final result publication is outside enforcement: it must remain possible to report a stop.
  Trace sinks and synchronous progress callbacks remain the existing observation seams.

Separate top-level calls are separate runs. Use a suite case for discover/freeze/replay/repair
under one allowance, or [a workflow owner](#workflow-composition-305) to compose separate calls
and host work under one allowance.

## Accounting

One admission is an engine call to `LlmClient.complete` or the separately configured
`TargetSelector.select`. Reserve synchronously immediately before invoking the port; concurrent
calls cannot overdraw. Discovery decisions, assertion proposals, semantic judging, locator
repair, surgical repair and outcome rediscovery all use that gate. A failed or cancelled
admission is never refunded. Reaching N calls does not itself stop mechanical work: attempting
call N+1 stops the run before dispatch.

This is an **engine-admission cap**, not a cap on wire requests, provider billing or tokens.
HTTP transport retries stay inside one admission. Subprocesses may make internal model calls
the engine cannot see. A selector that refuses locally after invocation still consumes an
admission, even if its `requested` field is false. This conservative rule avoids refunds and
does not claim that every admission reached the provider.

Custom clients supplied through `llm` are covered. Arbitrary model work hidden inside a custom
Planner, Critic, StepHealer, ActionPolicy, handler, perception hook, or custom Driver is **not countable** by
this API; the host must bound it. The engine checks its own operation boundaries, but cannot
interrupt private side effects inside a host callback. A standalone `SelfHealingDriver` or
`LlmStepHealer` outside a budgeted entry point has only its existing local controls.
In particular, a preassembled `runHarness` has opaque planner/critic/healer instances: its
deadline is enforced, but privately held clients (including a prebuilt `LlmCritic`) are not
automatically metered. Use `runScenario(scenario, { llm, budget, ... })` for the supported model wiring.

## Deadline, cancellation and uncertain effects

Elapsed time uses a monotonic clock. A timer aborts the shared signal and checks at each
engine/driver/model boundary prevent dispatch after expiry, including a blocked event loop.
Built-in HTTP clients propagate it through fetch and retry backoff; subprocess clients kill
their direct child and reject a late successful exit. Descendant processes are not guaranteed
to terminate. The selector receives the same signal through its optional second argument.

The Driver port has no cancellation parameter. Existing Chrome and custom drivers can finish
an already dispatched operation, as can clients that ignore the signal. The engine **awaits
settlement and rejects the late value** rather than leaving an orphan continuation, dispatching
another action, or accepting success. A never-settling custom operation can therefore prevent
return: this is cooperative cancellation, not a hard wall-clock termination guarantee. Driver
local timeouts still matter. Cleanup is allowed after exhaustion; supplied drivers remain the
caller's responsibility. Cancellation never rolls back a browser action or a store write.

Custom step execution and step-healer dispatch have the same pre/post checks and uncertain-operation
record as driver calls. The owner drains all admitted operations before publishing its result or
advancing to the next suite case, including siblings left pending by a concurrent judgment failure.
Signal composition uses disposable listeners and works throughout the declared Node 20 range;
it does not require `AbortSignal.any`. Driver decoration also supports frozen host implementations.

When work is in flight, exhaustion records an operation with `outcome: "unknown"`. Do not retry
that action blindly. A freeze already dispatched may have persisted a *previously verified*
artifact; the budget cannot roll back a store. No new freeze is dispatched after expiry, and
no interrupted discovery/repair is returned as a verified artifact.

## Outcome and record

`runScenario`, `runHarness`, and suite cases return `passed: false`, `failure: "budget"` and
`verdict.budget`: limit, copied configuration, consumed admissions, elapsed milliseconds,
phase and optional uncertain operation. There is no green proof or healed scenario. Existing
step/action/observation records remain; the stop result carries the latest completed observation
and recorded actions, not a fresh browser request after expiry. Usage is the measured snapshot
available at the stop; late provider usage is not an invoice reconciliation.

Suite publication uses the final case verdict, not a buffered replay success: a subsequent freeze
failure is reported as an environment failure while retaining completed replay evidence and usage.

`discover` and `explore` cannot return a verified Scenario/finished report on exhaustion, so
they throw exported `BudgetExceededError`, carrying the same metadata, evidence and usage.
Caller cancellation remains a rejection with the original reason, not a budget verdict.

Trace 1.10 adds `budget-exhausted`; owned run/case lifecycles still end once. Standalone
discovery/exploration emit into the supplied trace scope without owning a new lifecycle.
Exhaustion is neither an app regression nor a repair trigger. It cannot weaken original checks,
select another model or retry an uncertain action. CLI exit 5 denotes exhaustion; suite priority
is flow (1), script (3), budget (5), environment (4), preserving real failures in other cases.

See [the runnable browser example](../../examples/run-budget.mjs) and
[user guide](../../docs/guide.md#execution-budgets).

## Workflow composition (#305)

`runWorkflow({ budget, signal? }, work)` is an opt-in owner for host-composed work: preparation
replay, main discovery or replay, and extra verification under one allowance. It is exported from
both the Node and the browser entry points. The owner holds the only allowance, deadline and
cancellation signal. Inside `work`, `workflow.borrow(name)` returns a frozen lease, and each lease
is one participant. The internal scope class stays private, so a borrower cannot reset, extend or
dispose the owner.

```ts
const outcome = await runWorkflow({ budget: { maxModelCalls: 10, timeoutMs: 60_000 } }, async workflow => {
  await runScenario(setup, { workflow: workflow.borrow("prepare"), driver });
  const found = await discover(intent, { workflow: workflow.borrow("main"), driver, llm });
  const verify = workflow.borrow("verify");
  await verify.operation("browser.open-orders", () => page.goto(ordersUrl));
  return verify.llm(llm).complete(question);
});
```

**Borrowing.** `discover`, `explore`, `runHarness` and `runScenario` accept `workflow: lease`.
A lease serves one engine operation, so each operation keeps its own attribution. A borrowed call
must omit `budget` and `signal`, because the owner holds both. Mixing them is rejected, and so
is a lease the owner did not issue. `runSuite` does not borrow. Its cases keep independent
allowances.

**Host work opts in explicitly.** `lease.llm(client)` reserves one admission before every
completion. `lease.driver(driver)` and `lease.operation(name, run)` check the deadline before
dispatch, await the work on expiry and reject its late result. Model or browser work that does
not go through a lease or a borrowed engine call is not covered and not counted.

Host work can await an engine call that borrows the same lease. The engine drains only operations
it registered. The workflow owner drains explicit lease operations as well as complete engine
calls. Sharing a participant's accounting does not make the engine wait for its enclosing host
operation. A host callback that starts lease work without awaiting it leaves that work to the
workflow owner. Both kinds of work retain the same allowance, deadline and participant record.

**One count per call.** The owner records every client and driver it wraps. Engine wrapping
unwraps a client or driver the same workflow already manages first, so a lease client passed to
a borrowed call (or wrapped twice) reserves once. A client that hides a lease client inside a
different wrapper object cannot be recognized and is counted at each layer. Pass the lease
client itself or the raw client.

**Accounting.** It is the same as above. Reservation is synchronous and happens before
dispatch for every admission: concurrent completions, concurrent participants and
`TargetSelector.select`. Failed and cancelled admissions keep their count. Decisions, assertion
proposals, judgments and every repair layer of a borrowed call draw from the shared allowance.
Each participant reports its own admissions and measured usage, and the participants add up to
the aggregate count.

**Stop.** Exhaustion stops admission for every participant. The borrowed call that observes it
drains its engine operations, closes a trace it opened (`budget-exhausted`, `case-end`,
`run-end`, once), and throws `BudgetExceededError` carrying its own phase, uncertain operation,
evidence and usage. It does not call its reporter. A borrowed `runHarness` or `runScenario`
throws instead of returning a budget verdict. The workflow then refuses new leases and
operations, and late results are rejected.

**Owner lifecycle.** The owner is open while `work` runs. Then it drains every admitted
operation from all participants, including siblings that were left pending after an earlier
rejection. Whole borrowed calls remain tracked through owned-driver cleanup and final trace or
report publication, even between port operations. Already dispatched host work may settle while
draining, but no new operation can start. A failure from unfinished registered work during draining
rejects the owner instead of returning a completed callback value. The owner observes those
promises even when `work` no longer awaits a sibling. While `work` is open, it remains responsible
for awaiting and handling failures; explicitly recovered failures do not poison the workflow.
It then closes and releases its timer and caller listener exactly once, and only after that does
it return. Its outcome is one of these:

- `{ status: "completed", value, modelCalls, elapsedMs, participants }`.
- `{ status: "exhausted", budget, participant?, participants }`. It has no value. It is neither an
  application failure nor a partial success, even when `work` caught the error and returned.
  `participant` names the participant that hit the limit. Otherwise it names the one with the
  latest in-flight operation, and failing that, the most recently borrowed one. Each participant interrupted by the stop carries
  `stop: { phase, operation?, evidence? }`.
- Caller cancellation rejects with the caller's reason, including when draining continues past
  the deadline. The first cancellation or exhaustion retains its cause. Any other error from
  `work` is rethrown after draining; otherwise a failure encountered while draining is rethrown.

**Cleanup.** A driver's `close` stays callable after exhaustion. Run resource cleanup after
`runWorkflow` returns. By then nothing admitted is still in flight, and a lease no longer
authorizes verification, repair or business actions. The engine never retries an operation
whose outcome is unknown.

**Unchanged.** The workflow is a runtime control. It never enters a Scenario, `caseHash` or
judgment-contract fingerprint. Healthy frozen replay under a zero-call workflow makes no model
call. A call without `workflow` behaves exactly as before. The cooperative-cancellation limits
above apply in full: work that ignores the signal or never settles still delays the owner's
return, and admissions are not a cap on provider requests, tokens or spending.
