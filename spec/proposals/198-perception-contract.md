# Proposal: perception responsibility and observation identity (#198)

**Status: proposed, pending maintainer discussion in [#198](https://github.com/team-poem/cairn/issues/198).**
This document does not establish a public API or change runtime behavior. The two decisions
below are independent; agreeing to one does not approve the other or close the issue.

## Problem and current boundary

A body-level portal can put an active option after enough background controls to miss the
60-element prompt budget. A chosen duplicate can then be re-found by name as a different node.
These are separate failures: getting the candidate into the prompt and acting on that candidate.

Custom Drivers already receive engine ranking in discover and explore. [PR #216](https://github.com/team-poem/cairn/pull/216)
moved existing ranking and clickable quota calculation into `core/perception.ts` and fixed
budget overflow. It did not expose a shared perception API. Chrome still measures clickable
regions, promotes labels, and probes occlusion. Locate-heal takes the first 60 elements;
step-heal renders all elements. Neither currently shares the discovery ranking contract.

The [review request](https://github.com/team-poem/cairn/pull/216#issuecomment-5581202763)
asks for agreement on observable facts and ref lifetime before implementation. The withdrawn
implementation is historical evidence, not an approved design.

## Decision A: Driver facts, engine selection

**Recommendation:** keep browser measurement and actuation behind `Driver`; put selection for
model prompts in the engine. Specify the input contract before exporting policy helpers.

- A snapshot supplies the candidates the driver can observe in a stable source order, before
  any LLM ranking or prompt cutoff. Collection/transport limits are distinct from prompt
  limits; capture completeness must be representable when a driver cannot return everything.
  The engine cannot recover candidates discarded by the driver.
- Apply the consumer's perception adjustment before engine selection. Selection then applies
  ranking, evidence reservation, and the final budget once. For nonnegative integer budgets,
  zero means no rows, and every positive budget is a hard maximum.
- Preserve original candidate identity and full-snapshot duplicate ordinals through filtering
  and ranking. Display position must not become a new meaning for `nth`.
- Treat measured interaction facts separately from accessible roles and names. The proposed
  direction is optional facts, rather than declaring a measured clickable `div` to be an ARIA
  button. Missing measurement means unknown, not false. Existing Drivers retain their current
  behavior until they opt into an agreed capability.
- Positive hit-test evidence may establish occlusion. Outside the viewport, unsupported
  frames, and failed probes do not establish occlusion. DOM probing stays adapter-owned;
  the engine can only select using the facts actually supplied.

**Agreement still needed:** whether clickable/occlusion facts belong in engine vocabulary at
all; their provenance and unknown representation; and which measured popup relationship can
justify a priority change. A clickable flag alone does not fix the portal cutoff. Cursor style
alone also does not prove a successful action or a checkbox's framework-owned state.

Before implementing popup priority, choose an observable active-popup relation and an explicit
ordering against intent evidence and background controls. Use a fixture with 80 background
buttons and a trailing open listbox to decide it. Include more options than the budget: the
contract must state which options are omitted, rather than promise every active option fits.
This proposal does not choose a new scoring formula or expose Chrome's region representation.

## Decision B: observation-bound addressing

**Recommendation:** keep semantic page content, temporary observation addressing, and durable
replay targets separate. Bind decisions through a table accompanying the current observation;
keep backend handles private to the driver. Exact port names and types remain for agreement.

1. Semantic content used for unchanged-page compression and dead-action detection contains no
   refs, observation IDs, or handle generations. Fresh IDs alone must not make a no-op look
   like progress. Checked, disabled, value, and other semantic changes remain observable.
2. The engine gives refs the lifetime of the observation used to request one decision. A ref
   maps to an original candidate, not a row number after ranking. A current table must reach
   the model even when the semantic prompt says the page is unchanged.
3. Bind a referenced decision before ambiguity and consumer policy checks. Those checks see
   the selected candidate's canonical name, role, and persistent target description. Reject
   contradictory ref/text/role combinations; a ref-only decision cannot bypass `ActionPolicy`.
4. The driver validates continuity of the exact node through locator enrichment and dispatch.
   Translating the ref into a name and running ordinary name resolution again is insufficient.
   Detached/replaced nodes, navigation, target/tab replacement, or unprovable continuity fail
   resolution. Identical page text does not establish node continuity.
5. A decision attempt consumes its addressing table; a newer observation supersedes it.
   Unknown or expired refs fail without falling back to text, index, or a neighboring duplicate.
   Any retry requiring another decision takes a fresh observation within existing retry limits.
6. Derive the persistent `Target` from the exact selected node before acting. The proposed
   default is to refuse an action when that cannot be done; do not produce a step that only
   works while its ephemeral handle exists. Existing targeting strength warnings still apply:
   extracting a locator does not prove it will survive every future page change.
7. Freeze and re-freeze store only persistent locators and preserve the step's intent/expect.
   Refs, addressing tables, backend handles, and observation generations do not enter frozen
   scenarios. Replay retains the existing deterministic multi-locator behavior.

Consumer perception transforms need an explicit identity-preservation rule: reordering or
filtering may retain a candidate binding, but a synthesized row cannot inherit an unrelated
node's ref. The exact capability and transform contracts must be settled before code.

Observation identity is not durable business identity. It does not fix reordered duplicate
records on a later replay, or prove cross-observation identity for idle-scroll pruning.
Drivers without the capability keep the legacy path without an exact-node guarantee.

## Integration and acceptance

| Path | Required disposition before an implementation PR |
| --- | --- |
| Discover / explore | Share selection and binding rules; preserve policy checks and no-op detection. |
| Step heal | Use the same observation protocol; preserve strong locators and original intent/expect. |
| Locate heal | Include an explicit migration from the current first-60, name-only reply, or document its deferral without claiming all healing paths support refs. |
| Freeze / replay | Persist only current `Target` locators; no new interaction verb or LLM on replay. |

These are review examples, not implemented tests. After agreement, draft failing cases for
human review before implementation under the workspace's TDD workflow.

| Example | Required result / decision |
| --- | --- |
| Legacy custom Driver, 100 buttons plus matching success text | Existing engine ranking and evidence reservation apply; no new Driver capability required. |
| Budgets 0, 1, 60; duplicate names cut or reordered | Never exceed the budget or mutate source candidates; retained duplicate ordinals remain tied to the full snapshot. |
| 80 background controls plus trailing open listbox | Chosen popup policy keeps relevant options available; specify evidence competition and popup-over-budget behavior first. |
| Offscreen node or failed hit-test | Unknown occlusion, not evidence of a covered node. |
| Same semantic page with fresh refs; a no-op click | Compression and dead-action comparison stay semantic; current refs are still delivered. |
| Checked/value/disabled changes | Semantic comparison can observe the change. |
| Perception reorders duplicates or synthesizes a row | Original bindings survive reordering; synthetic rows cannot acquire another node's binding. |
| Same-name neighbor inserted; selected node replaced; tab/navigation changed | Dispatch the original node only if continuity is provable; otherwise fail resolution, without substitution. |
| Ref-only, unknown, expired, or contradictory selection | Consumer policy sees the bound element; invalid refs fail closed. |
| No persistent target can be extracted | Under the recommended default, refuse before action; do not report a successfully frozen step. |
| Discover and supported heal paths save and reload a scenario | No ephemeral addressing data; existing strong locators, intent/expect, and replay semantics survive. |

## Review and delivery boundary

Discuss A and B separately in #198. Record whether optional measured facts are accepted, the
popup priority evidence, and whether an engine-owned observation lifetime with exact-node
dispatch is accepted. Then settle capability opt-in, perception transforms, and which heal
paths the first implementation supports. A contract-documentation slice, selection changes,
and identity implementation can be reviewed separately after those decisions.

Current source anchors: [`core/perception.ts`](../../packages/harness/src/core/perception.ts),
[`discover/prompt.ts`](../../packages/harness/src/core/discover/prompt.ts),
[`discover/decision.ts`](../../packages/harness/src/core/discover/decision.ts),
[`explore/findings.ts`](../../packages/harness/src/core/explore/findings.ts), and
[`self-heal.ts`](../../packages/harness/src/adapters/drivers/self-heal.ts).
The governing specs remain [architecture](../architecture.md) and [targeting](../core/targeting.md).
