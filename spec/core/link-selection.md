# Declared positions over plain links (#343, phase 2)

A grid of ordinary links has no accessible list root and no `listitem` members, so the
[collection position](collection-selection.md) contract cannot address it, and legacy `nth` only
counts links with the same accessible name. `Target.collection.links` lets the host declare which
links form the collection. Discovery executes the declaration, the freeze keeps it, and every replay
resolves it against the current page with no model call. The same
[declared selection](discovery-selection.md) carries it through discovery, and the same Scenario
persists it for hand-authored replay.

```ts
const target = {
  collection: {
    links: { scope: ".grid", member: ":scope > a" },
    order: "dom",
    index: 1,
    expectedCount: 3,
  },
};
```

With `[A, B, C]` this selects B. After a reorder to `[C, A, B]`, a fresh replay selects A.

## Declaration

`links` is exclusive with the role form: `root`, `itemRole`, `target`, `conditions` and `choice` are
refused, and so is any unexpected field. All selectors are nonblank strings of at most 512 characters.

- `scope` must match exactly one element in the top-level document. It bounds the collection and
  its continuity guard. No match fails as `missing`; several fail as `ambiguous`.
- `member` runs as `scope.querySelectorAll(member)` and must start with `:scope`. Every match is a
  member. A member that contains another member fails as `ambiguous`.
- `action` is optional. Without it, the member itself must be the link (`<a href>`). With it, the
  selector runs inside the member, for example `{ member: ":scope > .card", action: "a[href]" }`.
- `group: "destination"` requires `action`. It allows a member to hold several links when they all
  resolve to the same `href`, such as a card's image link and title link. The member still counts
  once, and the first link in DOM order receives the click. Links with different destinations
  leave the member without an action. Equal URLs in different members are never merged.
- `expectedCount` is required, and `index` must be below it. Plain links expose no total, so the
  host's count is the only completeness evidence. It is trusted input: a count that happens to
  equal a lazily loaded window cannot be detected, as for the role form.

Predicate `choice` and `conditions` are not supported for links.

## Membership, order and visibility

The member list is the declared selector's DOM order. CSS visual order (`order`, `row-reverse`,
grid placement) is never read. A member keeps its position whatever it shows: a badged or
"official" card that matches the selector is counted.

- An off-screen member, outside the viewport or a scroll container, is counted and can be
  selected. The Driver's click scrolls it into view. Occlusion is only measured for a member in
  the viewport.
- A member that is not rendered (`display: none`, `hidden`, `aria-hidden`, zero opacity, hidden
  visibility) or that belongs to host-excluded UI refuses the whole collection. It is not skipped,
  so the requested position never shifts to the next usable link. A host that wants such members
  left out declares that in the selector.
- A member whose link is missing, ambiguous, not an `<a href>`, or has no accessibility node keeps
  its position with no action. Selecting it fails; the engine never clicks a neighbor.

## Driver boundary

`Driver.observeCollection` receives the link declaration and returns the same
`CollectionObservation` as the role form, one item per member. Core checks completeness, the
declared count, positions and the selected action, which must be a `link` (its name is not checked,
because an image link may have none). A Driver that does not recognize `links` must refuse it, not
read it as a role declaration.

The Chrome adapter passes every accessibility `link` row (at most 4,096) to one guarded DOM
measurement. In the page it resolves `scope`, `member` and `action`, and binds each member's link to
its exact accessibility node. The existing collection guard applies unchanged: the same mutation
revision as the accessibility capture, host-ownership policy, incoming `aria-owns` checks, and no
shadow roots, frames or `aria-owns` inside the scope. Each selected link's `href` and `target` are
part of the measured signature. A changed membership, order, selected node or destination before
dispatch expires the selection with no click and no re-resolution.

## Verifying the destination selected in this run

Selecting the right position and arriving at the right destination are separate checks. Bind a link
selection with `source: { kind: "href" }` and `destination: { kind: "location" }` in a
[selected-item binding](selected-item-evidence.md), or as `verify` on a discovery declaration. These
key kinds pair only with each other and only with a link collection. Attribute keys stay with the
role form.

- The source key is the selected link's `href`, read from the exact guarded node before dispatch
  and confirmed unchanged by the final continuity check.
- The arrival is the top-level `location` at the selection step's after-step boundary, read
  independently of the link and only in the tab the click was dispatched in. If another tab is
  selected when the departure marker or the arrival is read, for example because the original tab
  closed and Chrome selected the next one, the relation is unconfirmed. The binding's destination
  prefix must equal its source prefix: a later step, such as a `goto` or a breadcrumb, could reach
  the selected href itself and hide a wrong arrival.
- Both sides drop the fragment. The query is compared exactly. Redirects are compared on where the
  browser landed, so a redirect that changes the URL fails. A host whose links redirect to a
  canonical URL declares the canonical `href` or uses an attribute binding on a role collection.
- Values over 256 characters cannot be compared and leave the relation unconfirmed.

Chrome refuses, before dispatch, a selected link that opens another tab (its own `target`, or a
`<base target>` when it has none, other than `_self`), downloads, is not `http(s)`, or points at the current document apart from its fragment.
It plants a document-local marker before the click. If the marker survives, no new document
committed, and the relation is unconfirmed (required inconclusive). A pushState-only navigation is
therefore unconfirmed too. A newly opened tab is unconfirmed. Selecting B and arriving at C fails;
missing or stale arrival evidence cannot pass. A matching destination does not prove unrelated
business outcomes.

A full navigation usually takes longer than the default 2,000 ms source deadline. Pass a larger
`selectedItemEvidence.timeoutMs` on replay. A late result is unconfirmed, never retried.

The arrival is sampled once. A script redirect that runs after that read is not seen, and a
`<base href>` swapped and restored between the `href` read and the final guard can make a correct
arrival fail. Neither can authorize another click.

The frozen step keeps only the declaration. It never holds the discovery item's address, label or
refs as a post-condition.

## Verification

`test/link-selection.test.ts` covers discovery, save/load and fresh replay after a reorder with zero
model calls, a B-to-C destination mismatch, and declaration validation.
`test/browser/link-collection.browser.test.ts` measures real DOM in Chrome: DOM versus visual order,
a badged first card, off-screen members, wrapped and grouped cards, hidden members, empty,
ambiguous, nested, miscounted and invalid scopes, pre-dispatch changes, and the destination
check's single dispatch and its refusals (new tab, `<base target>`, download, same document,
non-http).
`npm run test:link-selection` also runs `scripts/test-link-selection.mjs` against real Chrome/MCP
with full-document navigation: a reorder, a redirect to another post that fails, a swallowed click
that stays inconclusive, a click that closes the original tab so another tab showing the expected
post is selected, which stays inconclusive, and grouped image and title links.
