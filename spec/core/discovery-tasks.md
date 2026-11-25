# Continue discovery with declared tasks (#337)

`discoverWithTasks(intent, { ...options, taskPlan })` uses the existing discovery loop but lets
the host decide which tasks remain. If the model proposes `done` after opening document A, the
loop can ask for another decision on a fresh observation to open B and C. It does not restart A.
Ordinary `discover()` is unchanged.

## Author the plan

The host supplies the complete scope before the run. Each task authorizes one action; declare
separate tasks for the steps of a multi-action route. For example, on an app where the buttons
“Open A” and “Open B” navigate to known, distinct document URLs:

```ts
import { discoverWithTasks } from "cairn-engine";

const ids = ["A", "B"];
const { scenario, progress } = await discoverWithTasks("Visit both documents", {
  driver, llm, baseUrl,
  taskPlan: {
    tasks: ids.map(id => ({ id, instruction: `Open document ${id}` })),
    ordered: true,
    onFailure: "stop",
    match(decision) {
      if (decision.action !== "click" || decision.role !== "button") return undefined;
      return ids.find(id => decision.text === `Open ${id}`);
    },
    assess(id, _step, observation) {
      return {
        route: observation.url === new URL(`/docs/${id}`, baseUrl).href ? "completed" : "unavailable",
        verification: "unknown", // Arrival alone does not verify the document's contents.
      };
    },
  },
});
```

- Declare 1–32 unique task IDs and short instructions. IDs are at most 64 characters, start with
  an ASCII letter or digit, and may also contain `_`, `.`, `:` and `-`. Instructions must be
  nonblank and at most 256 UTF-16 code units. Only eligible pending tasks are offered in the prompt.
- With `ordered: true`, only the first pending task is eligible. By default any pending task is
  eligible. Reusing the plan in a new invocation starts all tasks from pending.
- `match(decision, observation)` and `assess(id, step, observation)` are synchronous, trusted host
  callbacks. Use `match` to identify the task for this action **on this page**, or return
  `undefined` to refuse it. For example, if every document has a button named “Confirm”, match
  the active document as well as the button. Keep `match` free of side effects: the engine checks
  the proposed action again against a fresh page before input. If the same task no longer matches,
  it discards the decision without sending the action. A task ID cannot override a policy refusal,
  a declared guidance prerequisite, or a measured action restriction. Model-proposed `goto` is
  not allowed; the host can still supply `baseUrl` for entry.
- Chrome requires the original exact ref for a target-bearing task action, or a validated
  [scoped click](page-guidance.md) for the declared button. If Chrome cannot guard the target
  (for example, on a page with an unsupported shadow tree), it does not fall back to a substring
  or positional locator. An adapter that uses exact role/name lookup can still run a listed row
  without a ref when a fresh observation identifies the same target description. Rechecking
  `match` does not lock the page. If a changing prerequisite must hold up to the actual click,
  declare it in the guidance scope so the driver can check it at dispatch.
- `assess` runs on a fresh observation after confirmed execution, not on a proposed action or the
  model's account of it. Report whether the route reached its target separately from the result of
  any check. Explicitly choose `onFailure: "stop"` or `"continue"`; use `"continue"` only when
  the remaining tasks can run independently. Failed and unavailable tasks are not retried.
- Task callbacks see the measured URL (possibly absent) and page rows, independently of changes
  another policy hook makes to its own context. A policy that uses a last-known URL to stop
  discovery still gets that fallback; the task plan cannot use it as evidence of arrival.
  When typing an origin-scoped secret, both checks must pass: the secret must be allowed at
  the observed origin, and the fresh page must still match the task before the value is sent.

## Read the result

`progress.tasks` reports each ID's route (`pending`, `completed`, `unavailable` or `unconfirmed`)
and verification (`passed`, `failed` or `unknown`). `completed` and `remaining` count **routes**:
a visited document with the wrong title is still in `completed`, with verification `failed`.
`unconfirmed` includes an input that may have reached the page without acknowledgment. Discovery
does not resend that input to resolve the uncertainty.

`modelDoneCount` counts the model's valid `done` proposals. `reason` explains why the run stopped.
When every route completes with no known failure, the reason is `tasks-complete`; the loop needs
no final model decision. Unknown verification alone neither truncates the scenario nor triggers a
revisit. A verification failure or unavailable route stops immediately under `"stop"`, or remains
in the report as independent tasks run under `"continue"`. A terminal task failure returns
`scenario.truncated: true`. Existing policy and driver stop conditions still apply.

`maxEarlyDone` allows 0–16 early `done` proposals without route progress (default 2); the next
one stops discovery with `early-done-limit`. Another confirmed route completion resets the
allowance. Each new decision uses the same `maxSteps` (default 20), model-call budget and
deadline. As in [ordinary discovery](run-budget.md#outcome-and-record), a standalone call rejects
with `BudgetExceededError` on budget exhaustion or with the caller's cancellation reason on abort.

The returned `scenario` keeps authorized actions in order, including a required scroll even if
it caused no request and its next target was already visible. Replay does not consult the task
plan or reuse its progress report. To verify the contents on a later replay, author the required
assertions and collect fresh evidence for that run.

## Try it with Chrome

The [local fixture](../../scripts/test-discovery-tasks.mjs) runs the same scripted decisions with
and without a task plan. It checks actual click counts and retains one failed title check and
one unknown check even though all three documents were visited. It also replays a read-and-accept
flow in a new browser: acceptance requires the recorded scroll and replay uses no model calls.

With Chrome installed and `chrome-devtools-mcp@1.8.0` in the npm cache (or `CAIRN_MCP_ENTRY`
set to that version's installed executable JS entry), run from the repository root:

```sh
npm run build -w cairn-engine
node scripts/test-discovery-tasks.mjs
node scripts/test-discovery-task-admission.mjs
```
