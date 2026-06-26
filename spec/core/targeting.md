# Targeting — multi-locator + freeze stability

## Principle

Locate an element by **intent**, not by a *driver handle* → replay doesn't break when handles are invalidated (next session, re-render).

## Multi-locator (`Target`)

`{ text?, role?, index?, selector? }` — resolution priority:

- **`text`** (accessible name) = primary.
- **`role` + `index`** (position among same-role elements) = a rename-resilient fallback.
- **`selector`** (CSS) = an escape hatch for elements with no accessible name.

At freeze time, `Driver.locate()` *enriches* the target with strong locators before freezing → replay re-finds the handle with no LLM.

## Freeze stability scoring (#14)

`scoreTarget`: **selector 1.0 > role+index 0.7 > text-only 0.3 (weak).** Weak (text-only) targets are **warned** at freeze time → the author strengthens them up front, before they trigger a self-heal (LLM cost, non-determinism). Score + warning lower the self-heal trigger rate.

## Known pitfalls

- **Dynamic text targets:** if discover freezes a volatile name like `"Checkout 2 from Olive Young"` (count, store name), it mis-resolves when state changes → FAIL. → **#14 deepening** (score volatile tokens as unstable) + [surgical-heal](surgical-heal.md).
- **Positional silent mis-selection (P3):** the `role+index` fallback picks the wrong element **without throwing** when same-role elements are reordered/inserted → locate-heal never fires and there's no mid-step check → *silent wrong click*. Needs multiple anchors (nearby text / structural path) or *post-selection verification*.
- **Nameless elements:** with no accessible name an element is invisible in the a11y tree → the driver surfaces it with a **synthetic label** (`unlabeled-<role>-N`, the extension's `ExtensionDriver`) or via `selector`. The remaining cairn-side concern is the *stability* of that label (#14).
- **self-heal's text-only demotion (P5):** a heal that writes `click({text})` *drops role/index* → the opposite of what the freeze score recommends (every heal makes the scenario more brittle). A heal must **preserve** the strong locators.
