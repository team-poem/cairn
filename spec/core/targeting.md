# Targeting — multi-locator + freeze stability

## Principle

Locate an element by **intent**, not by a *driver handle* → replay doesn't break when handles are invalidated (next session, re-render).

## Multi-locator (`Target`)

`{ text?, role?, index?, nth?, selector? }` — resolution priority:

- **`text`** (accessible name) = primary. **`nth`** (0-based, same convention as `index`)
  qualifies it: the Nth element whose name matches — the readable, heal-friendly way to address
  one of several identically-named elements (list UIs: `{text:"Accept", role:"button", nth:2}` =
  the 3rd Accept button). Out of range → no match, never a neighbor. A position is only meaningful
  within one pool: a substring may name the pool when its matches are identical to each other, and
  the Chrome driver resolves a role-less `nth` over the compact tree on every attempt, since the
  verbose tree adds rows that shift a role-less count (#229).
- **`role` + `index`** (position among same-role elements) = a rename-resilient fallback.
- **`selector`** (CSS) = an escape hatch for elements with no accessible name.

At freeze time, `Driver.locate()` *enriches* the target with strong locators before freezing → replay re-finds the handle with no LLM. When the resolved name is duplicated on the page, `locate()` also records `nth`, so a frozen first-match is explicit about which duplicate it means.

The Chrome adapter removes virtual `ListMarker`/`InlineTextBox` rows, ignored wrappers and
generated text sharing those virtual UIDs at capture, with or without host ownership. Real
descendants and frame ancestry remain. Observation, document guards and fresh-ref validation
consume the same normalized tree: a virtual list marker cannot disable refs for real controls.
Unmeasurable real nodes still prevent unsafe ref publication; guard coverage is not relaxed.

## Explicit collection positions (#306)

Explicit first/Nth selection **within a collection** is a separate opt-in
[`Target.collection` contract](collection-selection.md). It does not reinterpret `nth`, enrich
with the selected resource's legacy locators, or allow automatic repair to choose another item.
Its plain declaration is authored by the host; ordinary model discovery is unchanged.

## Host-owned candidate exclusion (#308)

The Chrome adapter's optional `hostOwnedRoots` scope binds trusted host registrations to exact DOM
nodes, never page-supplied names/attributes. It filters compact and verbose candidate pools before
observation, promotion, named/positional/selector/reference lookup and freeze enrichment. DOM text
conditions and semantic progress use the same sanitized observation. Ownership changes expire refs
even when no DOM mutation occurred. Exact ownership and current host obstruction are checked again
before targeted dispatch; excluded overlays do not become click-through.

With active ownership, virtual AX rows, ignored wrappers and ambiguous duplicate UIDs are omitted
before DOM evaluation, without dropping their real descendants. MCP-unresolvable generated text
is omitted rather than guessed into an exact target. Other ownership/transport failures remain
fatal; no measurement failure falls back to an unfiltered candidate pool.

No registrations means no host-based exclusion. Enabling or disabling exclusion is **not** an automatic
migration of already-frozen positional targets: re-observe and re-freeze affected scenarios, and
keep the host policy consistent across discovery/replay. Tokens/DOM handles never enter scenarios.
The first adapter implementation supports top-level light-DOM roots, rejects active frame
boundaries and does not claim hostile-JavaScript isolation. Human UI, screenshots, network/console
evidence and conservative DOM settling/reference guards are preserved. See
[host-owned roots](../../docs/host-owned-roots.md) for the public integration, focus/geometry rules,
lifetime, unsupported cases and reproducible tests.

## Freeze stability scoring (#14)

`scoreTarget`: **selector 1.0 > role+index 0.7 > text+nth 0.6 > text-only 0.3 (weak).** An `nth`-qualified name is not penalized like a bare text target — for duplicate labels it *is* the strengthening (the name survives UI change; the position re-derives). Weak (text-only) targets are **warned** at freeze time → the author strengthens them up front, before they trigger a self-heal (LLM cost, non-determinism). Score + warning lower the self-heal trigger rate.

## Known pitfalls

- **Dynamic text targets:** if discover freezes a volatile name like `"Checkout 2 from Olive Young"` (count, store name), it mis-resolves when state changes → FAIL. → **#14 deepening** (score volatile tokens as unstable) + [surgical-heal](surgical-heal.md).
- **Positional silent mis-selection (P3):** the `role+index` fallback picks the wrong element **without throwing** when same-role elements are reordered/inserted → locate-heal never fires and there's no mid-step check → *silent wrong click*. Needs multiple anchors (nearby text / structural path) or *post-selection verification*.
- **Per-a11y-node text matching (#95):** `text` — in a `Target` or a `waitFor`/`expect` condition — is matched as a substring of a *single* node's accessible name. Text composed at render time is often several nodes: JSX interpolation like `Roster ({n}/{cap})` renders as separate StaticText nodes, so `waitFor {text: "Roster (1/3)"}` can never match even though a human "sees" the combined string. Author against a stable single-node substring (`"Roster"`) or use `role`/`selector`. (Joined-adjacent-text matching would be a new feature — deliberately not implied by the current contract.)
- **Nameless elements:** with no accessible name an element is invisible in the a11y tree → the driver surfaces it with a **synthetic label** (`unlabeled-<role>-N`, e.g. a CDP-direct consumer driver) or via `selector`. The remaining cairn-side concern is the *stability* of that label (#14).
- **self-heal's text-only demotion (P5):** a heal that writes `click({text})` *drops role/index* → the opposite of what the freeze score recommends (every heal makes the scenario more brittle). A heal must **preserve** the strong locators.
