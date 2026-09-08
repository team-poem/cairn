# Targeting — multi-locator + freeze stability

## Principle

Locate an element by **intent**, not by a *driver handle* → replay doesn't break when handles are invalidated (next session, re-render).

## Multi-locator (`Target`)

`{ text?, role?, index?, nth?, selector? }` — resolution priority:

- **`text`** (accessible name) = primary. **`nth`** (0-based, same convention as `index`)
  qualifies it: the Nth element whose name matches — the readable, heal-friendly way to address
  one of several identically-named elements (list UIs: `{text:"Accept", role:"button", nth:2}` =
  the 3rd Accept button). Out of range → no match, never a neighbor.
- **`role` + `index`** (position among same-role elements) = a rename-resilient fallback.
- **`selector`** (CSS) = an escape hatch for elements with no accessible name.

At freeze time, `Driver.locate()` *enriches* the target with strong locators before freezing → replay re-finds the handle with no LLM. When the resolved name is duplicated on the page, `locate()` also records `nth`, so a frozen first-match is explicit about which duplicate it means.

## Observation identity and shared perception (#198)

A discovery observation may attach an opaque `PageElement.ref`. The model copies that reference
into a target-bearing decision (`click`, `doubleClick`, `hover`, `type`, or `select`). The engine
requires exactly one matching row in the current observation, rejects conflicting name/role/nth
metadata, and supplies the observed name and role before calling `ActionPolicy.vet`.

Reference-capable Drivers implement optional `locateRef(ref)` and accept an optional trailing ref
argument on those five input methods. `locateRef` returns durable `Target` locators; the input
method uses the original observed node or rejects. A missing, expired, or detached reference
must never silently select a same-name replacement. The shared step handler receives the ref as
execution context; neither `Step` nor `Target` stores it. The engine copies only the declared
durable Target fields into the frozen step. Replay continues to use ordinary locators, with no
reference and no LLM. A reference error through `SelfHealingDriver` does not invoke locator heal;
the discovery loop takes a fresh observation and asks for another decision.

Chrome scopes references to one driver instance and observation generation, even when MCP reuses
the same raw UID. New snapshots, input actions, navigation, page switches, and close invalidate
them. This guarantees exact-node addressing or failure; it does not make page state atomic across
an observation, a policy check, locator capture, and input. `select` binds the original control;
options opened by that control still use its existing deterministic ARIA/native resolution.

`snapshot({ perception: true })` requests browser-neutral facts: `clickable`, `clickableRegion`,
`inActivePopup`, and `occluded`. Drivers may omit facts they cannot measure; older Drivers may
ignore the additive option entirely. `normalizeElements` and `rankElements` are available from
both the Node and browser entries. They preserve source roles and text evidence, de-nest proven
clickable regions, reserve at most 40 supplementary clickable priorities, prioritize active
popups inside the 60-row listing, and retain up to five intent-matching text-evidence slots.
Duplicate ordinals are computed from the full observation before listing exclusions or ranking.

The initial #198 implementation still has three reviewed edge cases pending additional test
approval: covered clickable rows can consume promotion regions/quota, evidence insertion can
exceed the listing budget when evidence already occupies the cut, and rotating refs can mask
unchanged UI in explore outcome comparisons. These prevent treating the issue as fully resolved.

The reference Chrome Driver reports exact-UID DOM measurements on this opt-in path. Expanded
ARIA control relationships and open dialog/popover state establish active popup membership.
Positive center-point coverage is occlusion; offscreen, clipped, zero-size, shadow-tree, failed,
or mixed-frame measurements remain unknown. Roleless promotion requires an observable inline or
property click handler and a pointer cursor; framework-delegated handlers are not inferred.
`promoteClickables: false` still disables that promotion. The default `snapshot()` path retains
the existing legacy role promotion and cached probe behavior.

This does not create DOM controls missing from the accessibility snapshot. A custom Driver can
provide an observed ref for a nameless control and a durable selector from `locateRef`; it must
reject if it cannot supply replayable locators. Framework-specific state repair remains the
consumer's `PerceptionAdapter` responsibility. Ephemeral refs cannot replace durable selectors
or make anonymous DOM structure stable across sessions.

## Freeze stability scoring (#14)

`scoreTarget`: **selector 1.0 > role+index 0.7 > text+nth 0.6 > text-only 0.3 (weak).** An `nth`-qualified name is not penalized like a bare text target — for duplicate labels it *is* the strengthening (the name survives UI change; the position re-derives). Weak (text-only) targets are **warned** at freeze time → the author strengthens them up front, before they trigger a self-heal (LLM cost, non-determinism). Score + warning lower the self-heal trigger rate.

## Known pitfalls

- **Dynamic text targets:** if discover freezes a volatile name like `"Checkout 2 from Olive Young"` (count, store name), it mis-resolves when state changes → FAIL. → **#14 deepening** (score volatile tokens as unstable) + [surgical-heal](surgical-heal.md).
- **Positional silent mis-selection (P3):** the `role+index` fallback picks the wrong element **without throwing** when same-role elements are reordered/inserted → locate-heal never fires and there's no mid-step check → *silent wrong click*. Needs multiple anchors (nearby text / structural path) or *post-selection verification*.
- **Per-a11y-node text matching (#95):** `text` — in a `Target` or a `waitFor`/`expect` condition — is matched as a substring of a *single* node's accessible name. Text composed at render time is often several nodes: JSX interpolation like `팀 명단 ({n}/{cap})` renders as separate StaticText nodes, so `waitFor {text: "팀 명단 (1/3)"}` can never match even though a human "sees" the combined string. Author against a stable single-node substring (`"팀 명단"`) or use `role`/`selector`. (Joined-adjacent-text matching would be a new feature — deliberately not implied by the current contract.)
- **Nameless elements:** with no accessible name an element is invisible in the a11y tree → the driver surfaces it with a **synthetic label** (`unlabeled-<role>-N`, e.g. a CDP-direct consumer driver) or via `selector`. The remaining cairn-side concern is the *stability* of that label (#14).
- **self-heal's text-only demotion (P5):** a heal that writes `click({text})` *drops role/index* → the opposite of what the freeze score recommends (every heal makes the scenario more brittle). A heal must **preserve** the strong locators.
