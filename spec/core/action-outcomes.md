# Action outcomes in discovery and exploration (#353)

A driver can click a heading successfully without reaching the link the model wanted.
`discover()` and `explore()` tell the next decision what changed after the last executed
action. A dispatch acknowledgement is not a state change, and neither proves the goal.
This feature never removes actions from a recording or adds a model call to replay.

## Enable a repeated-click limit

```ts
const actionOutcomes: ActionOutcomeOptions = {
  maxRepeats: 2,
  recoveryTurns: 2,
  onOutcome({ stepIndex, action, status }) {
    // Index in the original execution trail, including a seed goto when present.
    // Freeze-time idle-scroll cleanup can change later replay indices.
    console.log(stepIndex, action, status);
  },
};
const result = await discover(intent, { driver, llm, actionOutcomes });
```

Without the option, the feedback costs no additional driver calls and cannot block input.
In this mode, if the richer comparison is inconclusive, exploration keeps its existing
dead-action check: the two valid rendered listings and destination must agree, with no
new request. An invalid listing cannot establish that nothing changed.

Passing `{}` enables the limits above. Both must be positive integers; the maxima are 32
unchanged clicks and 16 recovery decisions. Only single clicks participate in the repetition
count. Two different nodes with the same label do not share a count, and a double click,
type or select is not a repeat of a click. Other executed steps still receive outcome feedback.

The next valid, settled observation compares the URL, cumulative request count and the rows'
accessible names, roles, values and interaction states. The comparison keeps the raw rows
before the model's listing cap, including rows a host omitted from the prompt. It also
uses changes to state that the host's `perceive` adapter measured on a matching control.
For example, a custom checkbox can expose its checked state through a class rather than
`aria-checked`. A changed host measurement is still evidence even when the raw accessibility
row stayed the same. Discovery redacts configured secret values. Chrome requests the extra
toggle and text comparisons only for opted-in perception snapshots. It does not read a
password's DOM value for comparison or treat matching password masks as equal values.

With the policy enabled, the loops read the URL and request count again before input. This
keeps a request that already finished while the model or locator was working out of the
action's request count. If the URL or request count changed since the decision observation,
the engine drops those rows from the baseline: it cannot tell what the new page or the
completed request changed before input. Otherwise it keeps the decision's rows. A change
on the same page may still happen before input without a new request. The samples are not
atomic with browser input and cannot establish causation.

If a policy approved a decision for one URL and the pre-input read shows a different URL,
the loop asks for a new decision before sending input. Discovery does not freeze requests
first seen between the settled observation of one action and dispatch of the next as an
expectation of either action. Exploration still reports a 500 or console error first seen
in that interval, marked `between-actions`. If a request is still pending, exploration
keeps its original interval until the status arrives. It tracks up to 256 such requests
at once. It can miss a later failure for an untracked pending request; this limit does
not apply to errors already observed with a final status.

- `observed-change`: a measured value changed, including navigation or a new request. A
  background change can also cause this; it does not establish that the action caused it.
- `no-observed-change`: the measured rows, known URL and request count agree. Hidden state,
  later effects and data the driver did not capture can still differ.
- `insufficient-evidence`: for example, the row set is empty, the target was not covered,
  a formerly measured fact is unavailable, or the request count reset. Losing a probe result
  is not progress. An independent positive change in a measured channel can still be reported.
  Ordinary unguided discovery often has no new URL/network read at
  prompt time; it can describe unchanged rows without claiming a complete comparison.

The comparison accepts at most 512 rows per listing and 32,768 characters of serialized
row state across the raw and host-corrected listings together. Above either limit it skips
row comparisons; URL and request evidence are still available. A host can set `scope(rows)`
to select existing raw rows that represent the relevant state, for example to omit a rotating promotion while
retaining the quantity and selected delivery method. Return `undefined` if required rows
are missing. Empty, duplicate or foreign rows do not establish coverage. A confirmed node ID
alone cannot establish that its state was observed. To count an unchanged click, the
comparison must also cover its target, whether or not the host supplied a scope. For
example, seeing a checkbox in both listings is not enough if neither the driver nor the
host reports whether it is checked. If the clicked control disappears but a declared
status changes from closed to open, the status change still counts as observed.
The row selector does not filter network traffic. A page that sends an analytics request on
every click can therefore keep the repeat limit from firing. The engine cannot tell an
analytics call from an application change by counting requests; the run's step and time
limits still apply.
The host owns the meaning and completeness of this selection. No comparison proves that it
is safe to drop a saved click or repeat a business mutation.

## Identity, recovery and limits

For the count, the driver must confirm which node actually received each click. Its
`armActionOutcomeIdentity` and `takeActionOutcomeIdentity` hooks surround one dispatch.
The pre-input callback can veto that exact node, even when the model uses a different ref.
Chrome measures a light-DOM node in the top-level document and checks for one trusted click.
A click on a label span inside its button can count for the button; a nested interactive
control does not count for its parent. Replacing a node with a new one, even with the same
accessible name, starts a new count. Losing the receipt on navigation or failing to identify
the node prevents counting the click but does not erase an acknowledged action.
A receipt identifies a node, not an accessibility row. If an ordinal or ambiguous name
cannot bind the click to one measured row, the engine does not infer unchanged target state.
A legacy driver without both hooks still gets feedback and the usual step/budget bounds.
Feedback and repeat gates contain neither receipt IDs nor compared values. The ordinary
perception listing can still show accessible names and values. Receipt IDs never enter the
prompt, trace or frozen steps. Mutable tracker state belongs to a single invocation.
Chrome's receipt lives in the page's JavaScript realm. The page can inspect or interfere
with it. It is a best-effort measurement for a cooperating application, never proof of
user intent, authorization for an input or a substitute for a scenario assertion.

For an ordinary tracked click that opens an informative `alert`, MCP 1.8 can report a
click timeout even though the page received the event. Chrome closes that alert and
records the click only if the original receipt independently confirms one trusted click.
It never resends the click. A rejected click with a `confirm` or `prompt` does not
authorize a choice. [Declared-scope guidance](page-guidance.md) keeps its stricter rule:
a rejected scoped click is not acknowledged by dismissing a dialog.

After the limit, the next decision can choose another control on a fresh page through the
ordinary policy and freshness checks. The same repeat limit applies to that new control;
switching targets does not grant more recovery decisions. A malformed decision, rejected proposal, `note`,
rotating ref or successful dispatch alone does not clear suspicion. Subsequent observed
change can clear it, including a delayed change to the original control after another
action was tried. This does not attribute that earlier control's change to the new action.
The final observation at the step cap also reconciles pending repetition without requiring
a host goal hook. Clearing repetition does not turn a step-cap stop into a verified goal. A model
`done` while suspicion remains, or exhausting the recovery allowance, returns
`truncated: true` with `action-no-progress`. Trusted goal checks on a valid observation
still win. Cancellation and shared budgets remain terminal; guidance expiration and the
existing scroll no-progress reason keep precedence when they apply. If input may already
have been sent and the driver does not acknowledge it, return the confirmed prefix with
`click-dispatch-uncertain` (or `action-dispatch-uncertain` for another input) rather than
retry or assign the new page to an earlier action. For example, failure after invoking a
driver's `pressKey("Enter")` does not authorize another submission.
Transport errors still propagate. No action-outcome result is verification evidence.

A driver can implement `armActionOutcomeDispatch` and `clearActionOutcomeDispatch` to
identify the actual input boundary. Failure to find a textbox before a fill allows a new
decision. Failure to find an option after clicking a custom dropdown does not: the first
input may already have changed the page. A legacy driver without a send or click hook
cannot make that distinction; a `resolution` error alone is not proof that it sent no
input. During tracked discovery and exploration, `SelfHealingDriver` leaves recovery to
the loop instead of retrying or silently substituting another control. Replay is unchanged.

## Measurement

Run `npm run build && node scripts/test-action-outcomes.mjs` against local Chrome and MCP
1.8.0. One inert click followed by `done` produced these driver `observe()` counts:

| Loop | Default | With `actionOutcomes` | With `actionOutcomes` and a separate `policy.vet` |
| --- | ---: | ---: | ---: |
| discover | 3 | 5 | 6 |
| explore | 2 | 4 | 4 |

Each extra `observe()` calls `list_pages`, `list_network_requests` and `list_console_messages`.
Both loops also made two `evaluate_script` calls for the click receipt. In this fixture
the option added no snapshots, inputs or model decisions. These are call counts, not a
latency estimate; settling a busy page can require more polling.
