# Host-owned instrumentation

`ChromeDevToolsDriver` can exclude a trusted host's instrumentation from agent observations and
target lookup without hiding it from a human operator. This is opt-in. With no registered roots,
ordinary browser behavior is preserved; no labels, CSS classes, attributes or application-specific
selectors automatically establish ownership.

```ts
import { ChromeDevToolsDriver, createHostOwnedRootScope } from "cairn-engine";

const ownership = createHostOwnedRootScope();
const driver = new ChromeDevToolsDriver({ hostOwnedRoots: ownership });

// In the host's existing DOM-injection integration, create the panel and retain its exact
// Element handle. Evaluate ownership.registerScript with that handle in the page's main
// JavaScript world, the same world used by the Chrome adapter:
await panelHandle.evaluate(
  (root, source) => new Function(`return (${source})`)()(root),
  ownership.registerScript,
);

// Explicitly release ownership when the host no longer owns the panel:
await panelHandle.evaluate(
  (root, source) => new Function(`return (${source})`)()(root),
  ownership.unregisterScript,
);
```

`panelHandle` above represents a handle supplied by the embedding host, for example a Playwright
ElementHandle. Cairn does not create a panel or supply that handle. Pass the script through the
host's existing browser transport; do not ask the model to find or register UI by selector. The
Playwright callback above explicitly invokes the generated function with the retained Element;
passing the function's source string directly to `ElementHandle.evaluate` only evaluates that
expression and does not call it. Compile only the trusted factory output, never model/page input.
If the host's execution environment disallows dynamic function compilation, use its equivalent
browser transport function-call API with the exact Element handle instead; do not silently skip
registration. Register/unregister return status including `active`, which the host can check.
The scope factory is also available from `cairn-engine/browser`, without Node dependencies, for hosts
that prepare their injection configuration in a browser. It does not automatically add support
to a third-party Driver. An extension's isolated world has different globals: registration there
is not registration in the adapter's main-world scope.

This is a cooperative instrumentation boundary, **not a security sandbox against hostile page
JavaScript**. The host must control which exact nodes it registers. The random scope separates
registrations; its key is not a secret or proof of authority against code executing in the same
page. Do not use this API to conceal failing application UI or as a permission boundary for
untrusted model-supplied scripts.

## What is excluded

- Ordinary and full/perception accessibility rows under an owned root, even when an intermediate
  wrapper is ignored by accessibility. Filtering happens before clickable promotion and selection.
- The same rows in named, role/index, `nth`, selector and exact-reference lookup, compact locator
  enrichment and deterministic replay. A selector that resolves into owned UI fails rather than
  falling back to a same-named application control. With active ownership, cross-role hit testing
  measures only exact nodes from the filtered candidate pool.
- DOM-derived text conditions (`waitFor` and step `expect`) and the semantic render used for
  progress/dead-action comparisons. A host counter update alone is not application progress.
- Ancestor semantic rows that aggregate owned content, and rows whose labels/descriptions or
  `aria-owns` dependencies involve owned nodes. These ambiguous rows are omitted conservatively,
  not assigned a fabricated accessibility name. This includes descendant name-from-content and
  reflected element references such as `ariaLabelledByElements`, not just attribute strings.
  Unrelated sibling application controls and exact application Text nodes remain, even when their
  parent also contains an owned panel. The 256-node reference bound applies to linked labels,
  not the number of ordinary descendant elements.

Chrome MCP resolves `StaticText` handles to parent Elements. The adapter therefore preserves the
captured AX role when checking ownership: a text row tests subtree ownership, while an Element's
aggregate name additionally tests descendant/label dependencies. A parent's mixed aggregate row
may be excluded without excluding an independent application text row under that same parent.

`RootWebArea`/Document remains the application page, including its title. Registration is not a
general text-redaction feature: a host writing into application-owned content, changing the page
title or issuing requests still has observable application effects.

Candidate filtering changes positional pools. A scenario frozen **with the same exclusion policy**
uses that filtered pool at capture, freeze and replay. Previously frozen `index`/`nth` targets are
**not automatically identity-compatible** when exclusion is enabled or disabled. Re-observe and
re-freeze affected scenarios; keep host injection and registration consistent across runs. Only
ordinary persistent Target fields are frozen, never a DOM handle, scope key or registration token.

## Lifetime and unsupported boundaries

Register connected, non-document Elements in the **top-level light DOM**. Exact identity matters:
unregistering another node does nothing; clones, replacements and matching IDs gain no ownership.
Detaching the root or one of its ancestors revokes registration, even if reattached before the
mutation observer callback. Re-register explicitly after intentional detach/reinsert. Navigation
and document replacement require new host injection/registration. A same-document route change
does not revoke a still-connected root.

Owned roots can contain shadow descendants; exclusion follows their shadow host ancestry. Roots
inside shadow trees cannot themselves be registered. Arbitrary shadow accessibility references,
closed-root focus inspection and cross-document ownership are not universally supported. Active
ownership with frame boundaries fails explicitly, including frames identified in the captured
accessibility tree. It is not silently applied only to the top frame. A host that needs frame or
different-world integration must implement and validate the same contract in its own Driver.

If exact node ownership cannot be measured, capture/lookup fails closed, not with the unfiltered
tree. Ownership changes invalidate captured refs even without a DOM mutation. Browser capture and
dispatch are separate operations, so this is not an atomic guarantee against arbitrary concurrent
page mutation. Re-observe after an ownership or geometry rejection.

## Input, human controls and evidence

The adapter never adds `aria-hidden`, disables controls, changes pointer events or hides the panel.
Human mouse, keyboard and assistive-technology interaction remain intact. Screenshots are unchanged.
Network and console evidence are not filtered, including requests and diagnostics from the host.

Before targeted dispatch, ownership is checked again and the current center hit must not land in
owned or ownership-dependent UI. An owned overlay still blocks application clicks, double clicks,
hover, input and select; exclusion never permits clicking through it. With active ownership, a
zero-size/offscreen/unmeasurable center is refused rather than letting MCP auto-scroll into an
unverified overlay. Scroll explicitly and observe again. This is intentionally more conservative
than default target dispatch; complex geometry is not promised to be universally actionable.

Agent `pressKey` refuses an owned focused node (including open-shadow focus) and refuses `Tab`/
`Shift+Tab` traversal while ownership is active. Otherwise it uses the normal keyboard path.
This does not isolate global event listeners or application shortcuts that deliberately invoke
host code. Human keyboard navigation is not modified.

Owned DOM mutations **still participate in settling and exact-reference validation**. No blanket
mutation ignore rule is installed: a counter can delay best-effort settling to its configured
timeout; a layout/name/cohort change can invalidate a reference. A completed unrelated text update
may pass the existing fresh-accessibility validation, but a subsequent host overlay is still
checked at dispatch. Thus semantic progress can stay unchanged without incorrectly promising DOM
quiescence or ignoring application occlusion.

## Reproduction

```sh
npm run build
npm run test:host-owned
```

Installed Chrome is required. `CAIRN_MCP_ENTRY` can point at an installed Chrome DevTools MCP 1.8.0
CLI; otherwise the smoke test uses its pinned `npx` package. The sanitized `host-owned.html` fixture
and browser suite cover exact-node lifecycle, duplicate pools, label dependencies, registration
races, human input, host obstruction, focus, settling and reference validation. The real MCP script
checks actual accessibility serialization, text verification, preserved evidence, scripted
discovery, freeze and zero-model replay. `host-owned-names.html` checks browser-computed nested and
reflected label names, positive application text and negative host-only conditions.
`host-owned-select.html` proves that reading the compact option watermark does not retire a
verbose-only opener UID, with both empty and active ownership. The browser suite also executes
the Playwright snippets above verbatim. These are synthetic regressions, not a live-model benchmark
or proof of universal instrumentation isolation.
