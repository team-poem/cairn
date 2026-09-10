# Perception — candidates, selection, and observation identity

The engine selects what the model sees; Drivers measure browser state and execute actions.
Discover, explore, surgical step-heal, and locator-heal use the same selection and observation
protocol. Legacy Drivers remain supported. Related: [#198](https://github.com/team-poem/cairn/issues/198),
[targeting](targeting.md), [architecture](../architecture.md).

## Driver input

`snapshot({ perception: true })` requests ordinary `PageElement` semantics plus optional facts:

| Field | Meaning |
| --- | --- |
| `inActivePopup` | Measured membership in an active popup; not inferred from snapshot position. |
| `occluded` | Positive hit-test evidence of coverage when true. Missing measurement is unknown. |
| `clickable` | A measured interaction candidate. It does not prove that clicking produces an effect. |
| `clickableRegion` | Observation-local identity of the measured click region, for de-nesting labels. |
| `ref` | An opaque Driver token for one observed node. Never a durable locator. |

Drivers supply candidates in source order before model ranking or truncation. Collection limits
remain a Driver limitation: the engine cannot restore candidates that capture omitted. Roles
and names retain accessible semantics; a clickable `StaticText` stays `StaticText`.

The consumer's `perceive` callback may correct state, filter, or reorder candidates. When keeping
a ref, it must preserve that candidate's accessible identity and role and use the ref once.
Names may differ only by surrounding whitespace or case; policy, dispatch and freeze retain
the raw canonical name. A synthesized row
must not borrow another row's ref. Full-snapshot duplicate ordinals survive transformations of
referenced candidates. Framework-owned checkbox state still belongs in this consumer seam;
the engine does not inspect a particular framework's internals.

Discover and explore reject invalid observation bindings before calling the decision model.
They can recover on a subsequent valid capture, with the existing step limit bounding repeated
invalid captures. Snapshot/consumer callback errors retain their own error behavior. A valid
JSON reply with a bad ref receives a binding diagnostic, separate from a JSON parse failure.

## Selection policy

The default prompt budget is 60 rows. Nonnegative integer budgets are hard caps, including zero.
Selection never mutates the source candidates:

1. Remove positively occluded candidates. Unknown/offscreen candidates remain eligible.
2. Assign at most 40 clickable-region representatives, preferring active-popup members, then
   original source order. Covered rows cannot consume a region or a quota slot.
3. Sort active-popup members first. Within each group, interactive roles or promoted clickables
   score 100, plus 10 per matching intent token; source order breaks ties.
4. Reserve room for up to five missed intent-matching non-interactive evidence rows, replacing
   only as many non-evidence rows as actually fit. De-nested or over-quota clickable labels can
   still supply intent evidence, without receiving a clickable promotion score.

This makes a trailing portal eligible ahead of background controls while keeping result text
available. A popup larger than the budget is itself truncated under the same score/tie rules;
evidence reservations may displace its lowest-ranked rows. The listing reports omitted rows.
With no optional facts, legacy ranking and evidence selection remain unchanged.

## Temporary addressing and durable targets

The engine builds a separate reference table for each decision. Model tokens map to captured
Driver refs and canonical candidate descriptions. Raw Driver tokens are not sent to the model.
The semantic page render contains no refs, so rotating handles do not defeat explore's
dead-action comparison. Each independent model request includes the complete current listing
and a fresh reference table, even when the semantic page is unchanged.
The reference table reports omitted candidates under the same hard row budget. Discovery,
exploration and surgical-heal systems teach ref-only target actions; a supplied description
must agree with the canonical element. Current page/reference data precedes the final action
instruction. Measured clickable and active-popup facts neither change roles nor prove effects.

A referenced decision is bound before ambiguity and `ActionPolicy` checks, which see its real
name, role, and full-snapshot ordinal. Unknown, expired, contradictory, duplicated, or fabricated
bindings fail; they never fall back to text or a neighboring duplicate. A decision attempt
consumes the table, and a newer observation supersedes the previous one. The engine rechecks
the bound observation and decision immediately before dispatch, including after asynchronous
locator enrichment and secret-origin checks.

To opt into exact-node addressing, a Driver implements `locateRef(ref)` and honors the optional
ref argument on `click`, `doubleClick`, `hover`, `type`, and `select`. Enrichment and dispatch
must use the same node. Resolving a ref to a name and then searching that name again does not
satisfy the contract. The existing step handler dispatches these actions; there is no new verb.

`locateRef` returns a persistent `Target`. The engine copies only `text`, `role`, `index`, `nth`,
and `selector` into the step, and refuses a ref action if no persistent locator is available.
Freeze and re-freeze never store the ref, browser handle, or observation generation. Step-heal
preserves original intent/expect; locator-heal forwards exact refs and never heals a stale ref
into a different node. Both repair paths accept policy/perception options. Configured secret
values are redacted before their shared prompt rendering, following the existing value-only
redaction contract; names and Driver tokens retain their addressing meaning.

Locator-heal and surgical step-heal `maxHeals` limits count repair model requests, including requests that fail or yield
an unusable repair. The attempt is reserved immediately before the model call, after observation
succeeds. Failed policy checks, locator enrichment, or retry dispatch still consume that attempt.
Only successful repairs enter `heals`; locator-heal triggers `onHeal` only after a successful
retry. This history is not the request budget. Both defaults remain 5 requests; increasing the
default requires evidence rather than silently compensating for failures now being counted.
An ordinary replay stops on an unrepaired divergent step; repeated calls or reuse of a
surgical healer still share its request cap.

Replay uses existing persistent locators with no LLM. Observation identity does not establish
durable business identity across later duplicate reordering, nor cross-observation identity for
idle-scroll pruning. Drivers without `locateRef` use legacy addressing without an exact-node
guarantee.

## Chrome capture and limits

Opt-in Chrome capture requests the full MCP accessibility tree because compact snapshots can
omit listbox options. It excludes virtual `InlineTextBox` runs, which can share non-actionable
UIDs; the owning text row remains. Ordinary no-options snapshots keep their existing shape.
The perception tree does not populate the ordinary compact cache used by legacy lookup and
custom select's before/after option comparison.
Replay resolution retries with the full tree when a compact snapshot omits a frozen target.
These retry captures remain local to resolution and never overwrite the compact cache.
Exhausted retries discard the compact cache too: later decisions must not dispatch nodes that
an intervening render removed. A successful verbose-only control lookup preserves the compact
before-open option watermark for custom select.

For a referenced decision, `locateRef` takes an additional compact snapshot and finds the exact
captured UID there before computing persistent `index` and `nth`. It verifies unchanged name
and role, checks that the persistent target resolves back to that UID, and revalidates the
observation after capture and immediately before publishing the locator. This keeps new frozen
targets consistent with ordinary replay without changing existing frozen-target semantics.

A candidate visible only in the full tree can still be listed with an observation ref, but
Chrome refuses to freeze that ref when the compact capture cannot retain its exact node. A
missing or changed node, failed capture, or expired observation invalidates the references;
Chrome does not reuse the full-tree ordinal or substitute another same-named element. Such a
candidate requires a Driver with a durable locator strategy. Existing frozen option targets
retain their compact-miss/full-tree replay fallback.
Legacy text/nth targets do not record which capture pool supplied their ordinal. Their
compact-first/full-tree fallback remains compatible with existing freezes, but it cannot
promise exact identity when those pools differ. The stronger guarantee belongs to newly
bound exact refs that pass compact re-anchoring, not to every historical ordinal target.

The DOM probe measures expanded `aria-controls`/`aria-owns` relationships, open dialogs/popovers,
hit-test coverage, and roleless cursor regions, including delegated click handlers. It treats
offscreen, clipped, detached, and shadow-tree hit tests as unknown. A cursor is only a candidate
hint. Mixed-frame or detached-UID batch failures are isolated; other measurable rows retain
their facts and region identity.

Exact refs are scoped to a Driver capture and guarded document. Chrome validates selected-page
identity, original-node connectivity, and a DOM mutation guard before enrichment and dispatch.
The guard retains the original DOM objects for the selected role's entire positional cohort,
including unnamed peers. It rejects node replacement and changes involving that cohort,
its ancestors/descendants, or candidate insertion. Clearly unrelated clock, spinner and image
updates trigger a fresh accessibility capture instead of immediately expiring every ref.
That capture must preserve the role/name sequence and original DOM object order. Fresh MCP
UIDs are resolved back to the saved objects: compact capture can discard a verbose-only peer's
UID, so UID-string equality alone cannot establish continuity.

Indirect CSS/ARIA dependencies still require conservative validation. Each revalidation gets
at most two full captures and requires one capture interval without another mutation; a page
that changes throughout both attempts is refused even if those changes appear unrelated.
The guard does not promise liveness under continuous mutation, and candidate-tag/ancestor
checks can conservatively reject benign changes. Retained mutation records are capped at
4,096; overflow disconnects the observer, releases retained records/cohorts and expires refs.
If any captured row is outside the guard
(including shadow trees or frames), or its coverage cannot be measured, the entire capture
uses legacy addressing: even document rows share duplicate ordinals with unguarded rows.
Measured facts remain available. Actions, recapture, navigation, and close
expire prior refs; MCP dispatch uses the captured UID once without name-search retries.

This is not a collector for every DOM node absent from accessibility. Fully nameless/roleless
widgets with no captured text still require a consumer Driver to supply candidates and durable
locators. The shared policy then applies to those candidates as it does to Chrome's.
