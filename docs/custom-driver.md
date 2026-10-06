# Implementing a custom Driver

A `Driver` is the engine's browser boundary. It performs user-level interactions and reports what
the browser did; the engine remains responsible for choosing among observed candidates and
judging a scenario. This guide documents the existing contract in
[`Driver`](../packages/harness/src/core/ports.ts),
[`perception`](../spec/core/perception.md), and
[`targeting`](../spec/core/targeting.md). It does not add a new capability or require a particular
browser library.

## Required contract

Every Driver implements the methods in the public `Driver` interface:

| Method | Responsibility |
| --- | --- |
| `goto(url)` | Navigate to the requested URL. |
| `click(target)`, `doubleClick(target)`, `hover(target)`, `type(target, text)`, `select(target, value)` | Resolve the target and perform the requested interaction. `select` chooses by value, including for supported ARIA combobox/listbox/option widgets. |
| `locate(target)` | Resolve a target and return durable, serializable locators that can be frozen and resolved again later. |
| `pressKey(key)`, `scroll(direction?)` | Send a key or key combination, and scroll up or down. |
| `snapshot(options?)` | Return the current page's accessible elements as `PageElement`s. |
| `settle(options?)` | Make a bounded, best-effort wait for the page to quiesce. It must resolve even when waiting fails. |
| `observe()` | Return navigation/final URL plus network-request and console observations. The engine adds its executed-action history to the completed run; `screenshot()` supplies optional screenshot data separately. |
| `screenshot()` | Return a screenshot data URL when available, or `undefined`. |
| `close()` | Release the browser session and its resources. Closing is terminal; create a new Driver for a new session. |

The interface is the source of truth for exact TypeScript parameter and return types. See the
[reference Driver tests](../packages/harness/test/adapters/drivers/chrome.test.ts) and the
[run tests](../packages/harness/test/run.test.ts) for concrete expected behavior.

## Interact as a user; report accessible semantics

Interaction methods must dispatch trusted, user-level input, such as browser-protocol mouse and
keyboard input. A synthetic JavaScript `.click()` is not equivalent: controlled components can
ignore untrusted events while the Driver incorrectly reports success.

`snapshot()` reports the page's accessibility semantics: each element keeps its actual role and
accessible name. A control whose state or identity is missing from the accessibility tree is
missing or misreported to cairn too. The engine does not inspect app-specific DOM to repair that.
If one application needs corrected perception, its consumer can wrap the snapshot in an
application-specific Driver; the durable fix is to expose the right accessible state in the app.

When `snapshot({ perception: true })` is requested, the Driver may add measured facts such as
popup membership, occlusion, clickability, clickable-region identity, and opaque node references.
Keep accessibility roles and names separate from those facts. Return candidates in source order;
the engine owns candidate ranking, evidence selection, and model-budget quotas. Do not truncate
the candidate list to the model's prompt budget before returning it. The
[perception contract](../spec/core/perception.md) describes the fact meanings and filtering rules;
the [perception tests](../packages/harness/test/core/perception-observation.test.ts) show examples.

## Basic targeting and exact references

The required, legacy-compatible path resolves a `Target` from its locators: accessible `text`,
`role` with same-role `index`, optional duplicate-name `nth`, and the `selector` escape hatch.
`locate()` should enrich a target with locators that remain meaningful after the current browser
session ends. Do not put browser element handles or transient protocol IDs in a frozen target.
Drivers without exact-reference support remain usable through this locator path.

Exact-node addressing is an optional stronger capability. To support it, implement
`locateRef(ref)` and honor the optional `ref` argument on **every** target-bearing action:
`click`, `doubleClick`, `hover`, `type`, and `select`. The ref must resolve and dispatch to the
same observed node. If it is stale, reject the action; do not look up its old name again or fall
back to a neighboring match. A `ref` is opaque and observation-local, never a durable locator.
`locateRef()` returns a persistent `Target`; the engine freezes only its supported locator fields
and never stores the ref or a browser handle. See the
[exact-reference tests](../packages/harness/test/core/perception-observation.test.ts) and
[Chrome Driver tests](../packages/harness/test/adapters/drivers/chrome.test.ts).

This distinction lets a Driver start with the required locator contract, then opt into exact
references only when it can guarantee node identity through enrichment and dispatch. Merely
accepting a `ref` parameter without honoring it does not provide that capability.

## Waiting and errors

`settle()` reduces races by waiting briefly for network or rendering activity to quiet down. It is
heuristic and best-effort: it is time-bounded and must not throw if the wait itself fails. It does
not prove that a step succeeded. Deterministic readiness comes from a step's `expect` post-condition
or an explicit `waitFor`, which the engine polls against `observe()` and `snapshot()`.

The Chrome Driver waits for both network and DOM activity to quiet down. A single pending
request or a new document mutation keeps the wait active, up to the configured timeout.
Declare an application's background polling explicitly through the Driver's wait defaults:

```ts
import { ChromeDevToolsDriver, runScenario } from "cairn-engine";

const driver = new ChromeDevToolsDriver({
  settle: { ignoreRequests: ["/api/notification-count", "/api/keepalive"] },
});
try {
  await runScenario(scenario, { driver });
} finally {
  await driver.close();
}
```

These defaults also apply to discovery and waits inside `type`/`select`. A direct call such
as `driver.settle({ timeoutMs: 2_000 })` overrides that field and retains the exclusions;
`ignoreRequests: []` clears them. Matching uses URL substrings, so choose patterns that do
not also match the flow's important requests. Excluded requests still appear in evidence
and can fail assertions. This option does not mark a failure `benign`.

When a Driver throws during a step, it can attach the structured `kind` from the existing
[`StepErrorKind`](../packages/harness/src/core/types.ts) contract. Create one with
[`stepError`](../packages/harness/src/core/errors.ts), or set the same plain `kind` property on
an `Error`. The accepted values are:

| `kind` | Meaning |
| --- | --- |
| `resolution` | The target could not be resolved. |
| `post-condition` | The interaction ran, but its expected result did not appear in time. |
| `timeout` | An explicit `waitFor` condition timed out. |
| `transport` | The browser or Driver transport failed, such as a disconnected session. |
| `handler` | The registered step handler or required host wiring is unavailable. |

The engine uses this classification to distinguish a script failure that should be re-discovered
from an environment failure that can be retried. An untyped error is treated as a script failure.
See [`classifyFailure`](../packages/harness/src/core/pipeline.ts), the
[CLI exit-code mapping](../packages/harness/src/cli-exit.ts), and the
[failure-class tests](../packages/harness/test/core/failure-class.test.ts).

## Ownership and cleanup

The code that constructs a Driver owns it. With `runScenario`, a caller-supplied `driver` remains
the caller's responsibility to close, including after a failed or aborted run. If `runScenario`
creates its own default Driver, it closes that Driver itself.

A suite has a different ownership boundary: `driverFactory` is called to create a fresh Driver for
discovery and for each case replay, and the suite closes each instance in a `finally` block. Return
a new, suite-owned session from every factory call; do not return a shared Driver or one whose
lifecycle the caller still needs. The
[suite tests](../packages/harness/test/suite.test.ts) and
[pipeline tests](../packages/harness/test/core/pipeline.test.ts) cover these ownership rules.

## Contract sources

- [`Driver` interface](../packages/harness/src/core/ports.ts)
- [Perception contract](../spec/core/perception.md)
- [Targeting contract](../spec/core/targeting.md)
- [Error construction](../packages/harness/src/core/errors.ts)
- [Failure classification](../packages/harness/src/core/pipeline.ts)
- [Chrome Driver tests](../packages/harness/test/adapters/drivers/chrome.test.ts)
- [Perception tests](../packages/harness/test/core/perception-observation.test.ts)
