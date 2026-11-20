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
row stayed the same. Discovery redacts configured secret values.

With the policy enabled, the loops read the URL and request count again before input. This
keeps a request that already finished while the model or locator was working out of the
action's request count. If the URL or request count changed since the decision observation,
the engine drops those rows from the baseline: it cannot tell what the new page or the
completed request changed before input. Otherwise it keeps the decision's rows. A change
on the same page may still happen before input without a new request. The samples are not
atomic with browser input and cannot establish causation.

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
URL and request evidence remain in scope.
The host owns the meaning and completeness of this selection. No comparison proves that it
is safe to drop a saved click or repeat a business mutation.

## Identity, recovery and limits

For the count, the driver must confirm which node actually received each click. Its
`armActionOutcomeIdentity` and `takeActionOutcomeIdentity` hooks surround one dispatch.
The pre-input callback can veto that exact node, even when the model uses a different ref.
Chrome measures a light-DOM node in the top-level document and checks for one trusted click
on that node. If the click lands on a child, navigation loses the receipt, or identity is
unavailable, the action is still recorded on success but cannot increase the repeat count.
A legacy driver without both hooks still gets feedback and the usual step/budget bounds.
Receipt IDs and compared values are never put in outcomes, prompts, traces or frozen steps
by this mechanism. Mutable tracker state belongs to a single invocation.

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

## Measurement

Run `npm run build && node scripts/test-action-outcomes.mjs` against the local Chrome/MCP
fixture. For one inert click followed by `done`, enabling the policy increased driver
`observe()` calls from 3 to 5 in unguided discovery and from 2 to 3 in exploration.
Each loop made two more MCP `evaluate_script` calls; snapshots and model decisions stayed
the same. These counts describe this fixture, not browser latency. It also counts DOM
clicks and MCP input requests separately for repeated clicks, recovery, a changing quantity
and a button whose `aria-pressed` state toggles on each click.
