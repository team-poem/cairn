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
a ref, it must preserve that candidate's name and role and use the ref once. A synthesized row
must not borrow another row's ref. Full-snapshot duplicate ordinals survive transformations of
referenced candidates. Framework-owned checkbox state still belongs in this consumer seam;
the engine does not inspect a particular framework's internals.

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
The semantic page render contains no refs, so rotating handles do not defeat unchanged-page
compression or explore's dead-action comparison. A fresh reference table is sent even when
the semantic page is unchanged.

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

Replay uses existing persistent locators with no LLM. Observation identity does not establish
durable business identity across later duplicate reordering, nor cross-observation identity for
idle-scroll pruning. Drivers without `locateRef` use legacy addressing without an exact-node
guarantee.

## Chrome capture and limits

Opt-in Chrome capture requests the full MCP accessibility tree because compact snapshots can
omit listbox options. It excludes virtual `InlineTextBox` runs, which can share non-actionable
UIDs; the owning text row remains. Ordinary no-options snapshots keep their existing shape.
Replay resolution retries with the full tree when a compact snapshot omits a frozen target.

The DOM probe measures expanded `aria-controls`/`aria-owns` relationships, open dialogs/popovers,
hit-test coverage, and roleless cursor regions, including delegated click handlers. It treats
offscreen, clipped, detached, and shadow-tree hit tests as unknown. A cursor is only a candidate
hint. Mixed-frame or detached-UID batch failures are isolated; other measurable rows retain
their facts and region identity.

Exact refs are scoped to a Driver capture and guarded document. Chrome validates selected-page
identity, original-node connectivity, and a DOM mutation guard before enrichment and dispatch.
The guard conservatively rejects structural/text/attribute changes, even if unrelated
to the selected control, because saved positional locators might already be stale. Re-observe
and re-decide instead of freezing such a target. If any captured row is outside the guard
(including shadow trees or frames), or its coverage cannot be measured, the entire capture
uses legacy addressing: even document rows share duplicate ordinals with unguarded rows.
Measured facts remain available. Actions, recapture, navigation, and close
expire prior refs; MCP dispatch uses the captured UID once without name-search retries.

This is not a collector for every DOM node absent from accessibility. Fully nameless/roleless
widgets with no captured text still require a consumer Driver to supply candidates and durable
locators. The shared policy then applies to those candidates as it does to Chrome's.
