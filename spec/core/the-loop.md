# The core loop — discover → freeze → replay → self-heal

## One line

Describe what you want in plain language; the AI finds that path **once** and freezes it; from then on it replays the path **with no LLM**, judging pass/fail on the evidence it collects. When it breaks, the AI returns **only then** to repair it.

## Four stages

- **discover** — the LLM observes, acts, and adapts its way through an *unfamiliar app* to find a path. The agent loop lives **only here** (invariant #3). It produces an *intent (`reason`)* for every action. An optional **`ActionPolicy`** (injected, invariant #2) gates each proposed action before it runs — a consumer can block destructive/irreversible controls, cap wandering, or stop on a goal, all app-agnostically (the engine offers the seam; the rules come from the host). Absent → every action runs (unchanged).
- **freeze** — the discovered path is hardened into a deterministic asset (`Scenario`). Targets are stored by *intent* (multi-locator), not by handle → see [targeting](targeting.md).
- **replay** — the frozen path runs with **zero LLM** (invariant #4). Same result every time.
- **self-heal** — when a step diverges at replay, the LLM repairs **just that step** and re-freezes (convergence). No break → no LLM. See [surgical-heal](surgical-heal.md).

## Why this shape — the LLM is expensive and non-deterministic

So the LLM is used **only for authoring (discover) and repair (heal)**; **repetition (replay) stays deterministic and free.**

- **"LLM once, free thereafter":** discovery is paid once (~$0.5); replay is $0. Regression runs every time at zero cost.
- **Determinism:** a frozen path is identical every run → trustworthy and repeatable (invariant #4).

## Where it bets — the determinism ↔ flexibility dial

| | Scripted (Playwright/Cypress) | LLM agents | **cairn** |
|---|---|---|---|
| Authoring | selectors & code | natural language | natural language |
| Every run | deterministic, cheap | LLM in the loop — slow, costly, flaky | deterministic, cheap (LLM-free) |
| UI changes | you fix selectors | re-reasons (may drift) | **self-heals, then re-freezes** |
| LLM calls | 0 | every run | once to discover + *only when it breaks* |

cairn's seat = **flexible at authoring/repair + deterministic at repetition.** The *one* sweet spot between pure scripting (zero flexibility) and LLM agents (costly, untrustworthy every run).

## Resolving the core tension (→ surgical-heal)

Pure `freeze→replay` **assumes a static state** → it breaks on stateful/dynamic apps (already logged in, state branches). So the **precision** of "LLM only when needed" is the crux: only *the step that diverged* must be repaired, surgically, so determinism and flexibility hold **at the same time**. This is the last gate to top marks → [surgical-heal](surgical-heal.md).

## Invariants (summary — canonical in `architecture.md`)

Optional [shared execution budgets](run-budget.md) bound model admissions and elapsed time
across these phases. They do not reset at repair, alter a frozen contract, or replace local caps.

deterministic replay · loop only in discovery · pattern ≠ data · extend through ports only · model/driver agnostic · dependency direction qa→harness.

## Optional observed scroll-cycle policy (#309)

`createScrollNoProgressPolicy()` plugs into `discover` and `explore` through `ActionPolicy`.
It is disabled unless supplied. It does not change replay, freeze-time idle-scroll pruning,
assertion grounding, or the shared execution budget. The detector makes no model calls;
re-decisions and the ordinary freeze assertion proposal can still cost model calls.

```ts
const policy = composePolicies(
  originFence,
  createScrollNoProgressPolicy({ tolerance: 4, recoveryTurns: 3, historySize: 32 }),
);
const scenario = await discover(intent, { driver, llm, policy });
```

The optional `createRun()` factory allocates state once per loop invocation. Both the policy
configuration and `composePolicies` are reusable across sequential/concurrent runs (each run
still owns a separate driver). Legacy stateful policies without a factory remain the host's
responsibility. Lifecycle hooks are trusted synchronous host code: they must not throw.
`observe(ctx)` runs once per fresh observation, including the final executed action's observation;
`executed(step, ctx)` runs only after successful dispatch. Neither proposals, another policy's
veto, nor failed dispatch are execution events. Composition forwards lifecycle notifications
once to every component, irrespective of vet order.

The optional `Driver.scrollState()` supplies positive region coverage and measured scroll
position, extent and viewport size. The loop brackets its snapshot with measurements and uses
them only when they match. An adapter must return `undefined` when it cannot establish coverage
of the region actually affected by its `scroll()` verb; absence is not zero or a cycle.
Chrome supports the top-level document only, and abstains for frames, shadow trees, nested
scroll regions, transformed/zoomed content, and DOMs beyond its 4096-element measurement bound.
It does not add nested-container scrolling. DOM scanning is supplemented by bounded real AX-node
root checks: closed-shadow descendants exposed by AX cannot pass as document coverage. An inaccessible
AX node also abstains. Independent body scrollers and individual CSS translate/rotate/scale are
unsupported, just like other nested regions and transforms. Fixed registered host
roots are omitted consistently with snapshot exclusion; in-flow host roots make geometry
unsupported. Screenshots, network errors and console evidence are not filtered by this policy.

Each run keeps an LRU history of exact, bounded semantic multisets (role/name/value/checked/
disabled/active-popup/occlusion/clickable state), URL and measured geometry. Row order, refs and rotating interaction
handles do not count as progress; duplicate counts and control-state changes do. A new position
counts as progress even if offscreen targets were already listed. Lazy content, recycled virtual
rows with different semantics, new extents and distinct document/region identities remain distinct.
The heuristic observes accessible semantics, not hidden application state or goal truth.

After `tolerance` executed scroll transitions revisit known states, tried scroll directions at that
state are rejected with a structured `no-progress` diagnostic. An untried direction can probe for
recovery, at most once per direction during the suspicion window; its successful dispatch alone
does not reset suspicion. Revisited results consume recovery turns too. Other actions get `recoveryTurns` further decisions;
merely alternating waits/notes/keys does not clear suspicion. A genuinely new observed state clears
it. Missing/oversized facts clear attribution and abstain, so this is not a substitute for hard
execution budgets. History eviction also abstains rather than guessing an old state's identity.
Default bounds are 32 states, 32768 serialized characters/state, tolerance 4 and 3 recovery turns;
all options are validated and capped. Signatures remain run-local and are never diagnostic hashes.

`incomplete()` reports suspicion and whether the recovery allowance is exhausted. A halt, step cap,
or model `done` while suspicion remains yields `truncated: true`, `truncationReason: "no-progress"`.
`done` cannot bypass this by preceding `vet`. A trusted `stop()` goal check still takes precedence,
and normal completion resumes after observed progress. No-progress is neither goal completion nor
an application-defect finding. Hosts that have independent valid goal evidence can supply `stop`;
the policy itself must not fabricate it from a lack of change. Explore also checks trusted goals on
the final executed action's valid observation. `runSuite`, outcome-heal results and `case-end` traces
preserve the optional `truncationReason`; incomplete paths still cannot be frozen as verified heals.
