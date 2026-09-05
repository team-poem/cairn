# Judgment — three-layer evidence

## Principle

cairn **does not judge by "the screen looked right."** It judges on observable facts in *three layers* — pressing the chronic AI-QA failure (*false pass*) down with evidence.

## Three-layer evidence (`Evidence`)

- **execution** — did it actually act/navigate. `{ actions, navigated, finalUrl, blocked }`
- **perception** — what it looked like. `{ screenshot }` (per step)
- **logic** — requests & console. `{ requests[{method,url,status}], console[{type,text}] }`

## Assertions (`Assertion`) — three kinds, one dispatch

- **mechanical** — `navigated{to}` · `no-failed-requests` · `no-console-errors` · `request-status` → **deterministic (no LLM).**
- **`expect`** — a natural-language criterion, **judged by an LLM** (`LlmCritic`). Opt-in via `--semantic` / `semanticChecks`. If present, replay calls the LLM → so it is **not put in the default freeze** (preserves determinism, invariant #4). None present → zero LLM.
- **`custom`** — defined by the product (`{kind:"custom",name}` + a host handler). *The product decides what "success" means.*

Routing = `AssertionHandler.supports() → judge()` dispatch — no branching inside a stage (invariant #2). The two critics (`AssertionCritic`/`LlmCritic`) differ only in *which handlers they register*.

## Fail closed — a verdict must not out-run its evidence

Three composition rules keep `verdict.passed` honest for the CI-gate use case:

- **No assertions → fail** (#69): an empty assertion set verifies nothing; `[].every` green is vacuous.
- **Blocked run → fail** (#90): assertions only prove evidence that was *collected*. If a step
  blocked (executed but its post-condition never held, or failed outright), the trailing steps never
  ran — assertions satisfied by the executed prefix must not read as a completed scenario. So
  `passed` requires *assertions hold AND every executed step ok*. `Verdict.detail` names the blocked
  step and its error, so a consumer can tell "run didn't finish" apart from "assertions failed".
  A *healed* step is recorded ok — self-heal, idempotent skip, and re-discovery are the sanctioned
  paths for "the step diverged but the goal is still reachable", not a passing verdict over a
  partial run.
- **All assertions vacuous → fail** (#137): at freeze, each derived assertion is evaluated against
  the *baseline* evidence (right after the entry goto, before any flow action); one the start
  already satisfies is stamped `vacuous` in the frozen data. A `request-status` hit is the
  strongest case — the request log only grows, so a check a landing-page request satisfied can
  never fail at replay. When *every* assertion carries the stamp, replay fails closed: a scenario
  that cannot go red proves nothing green. One discriminating assertion (including any
  suite-merged `origin: user` criterion, which is never stamped) keeps the verdict normal; the
  guards (`no-failed-requests`/`no-console-errors`) carry the stamp on a clean start but are not
  individually warned on — a flow action can still break them.

- **Unverified re-discovery → not a heal** (#186): outcome-heal's verdict goes through the same
  finalizer as replay. A re-discovery that ended before `done` (step cap or repeated policy blocks)
  fails closed, exactly as a truncated first discovery does; and neither that nor a re-discovery
  that reached `done` with a goal assertion still failing is handed back to re-freeze, so the store
  only ever holds a path that reached the goal. Guards (`no-failed-requests`, `no-console-errors`)
  are not goal assertions on either end: a guard tripping during the re-discovery does not discard
  a repair that reached the goal, and a replay red on guards alone does not trigger a re-discovery
  at all — nothing a re-discovery does can fix a 500.
- **Unprovable action → recorded, not yet failed** (#184, #172 follow-up): grounding refuses a
  `request-status` whose proving request has no stable path to check — the same predicate the
  freeze asks again here, so the two cannot answer differently and leave the gap between them
  passing silently. When the *flow* (not the entry page load) fired such a mutation on the app's
  own site and no proof survived, the freeze carries `Scenario.unprovenAction` (`METHOD url` of
  that request), the trace emits `gate: unproven-action`, and `cairn discover` warns: the
  assertions that did survive — a `navigated` above all — hold whether or not the action fired, so
  a green means "the page was reached", not "the work was done". Replay does **not** fail on the
  flag yet. Failing closed is the intent, but the gate's false-positive rate is unmeasured until the
  reliability bench (#169) exists, and a rule that reddens a read-only flow on background traffic
  costs more trust than the hole it closes; the flag is frozen so that rate can be counted, and the
  flip to fail-closed is a follow-up. Two limits are deliberate meanwhile. The proof half is coarse:
  **any** surviving `request-status` disarms it, including one proving a different action. And the
  site filter is structural, not a list — a request counts when its host is a page the flow visited
  or a subdomain of one — so third-party background posts (analytics, error reporters) never count,
  while same-site transport noise (a SockJS session mounted under a run-minted first segment) still
  arms it — the product clears that by marking the endpoint
  `benign`, the seam for app-specific noise.

## Grounded — "a green run means it actually worked"

When discover proposes assertions, it **grounds them in what actually happened** (`deriveAssertions`):
- a proposed `request-status` is kept *only if a captured request matches it* (hallucinations dropped);
- `navigated` asserts the *right destination* (host+path) — catching "navigated, but to the wrong
  page." A segment the run minted is frozen as `*`, which matches exactly one segment, so an order
  id in a confirmation URL does not pin the check to that run. Two limits keep the notation from
  buying that with a check that proves nothing: a destination whose path ends in a wildcard is
  refused (`/app/*` and `/products/*` are reached by that app's own `/app/login`), and the freeze
  degrades to a bare `navigated` stamped `vacuousBecause: "no-destination"` — so the verdict says
  the run navigated somewhere unnameable, not that nothing changed. The notation is declared per
  file by `Scenario.wildcards`; without it a `*` is matched as the literal character it was frozen
  as, so a page whose real path contains one keeps its meaning under a newer engine.

→ This deterministically fills the weak default ("only `no-failed-requests` → passed but wrong").

### Destination evidence before a mutation (#203)

Before grounding, final observation uses one **2-second polling budget** for both in-flight flow
mutations and a short post-response redirect. It keeps observing while the last qualifying
mutation-bearing step's pre-action URL and the current URL still name the same host+path; a
query/hash-only progress update is not a new destination. Qualification and request-tail ownership
are shared with the advisory below, so trailing scroll/wait steps do not erase the boundary.
Pending mutation polling retains its request watermark. Remaining time is passed to `Driver.settle`
and caps polling sleeps; a newly observed URL gets another bounded settle/observation to collect
the destination's evidence. Driver calls themselves can overrun their requested timeout, so this
is an observation budget, not a strict wall-clock deadline. No-action runs, reads, entry traffic,
failed responses, and successful benign/third-party traffic do not arm redirect waiting.

A derived `navigated` carries `observedBeforeLastMutation: true` when its destination already
matches the URL observed before the last executed step whose own request-log tail contains a
successful (200–399), non-benign mutation on a visited page's site. Final observed request statuses
and the consumer's locale/wildcard matching rules decide the stamp; entry traffic is excluded and
later steps without a qualifying mutation do not erase it. This records evidence provenance: the
URL proves arrival at that page, without proving navigation after the mutation. It does **not** say
that navigation is pending, that the mutation caused a navigation, or that an on-page save failed.
The stamp survives even when a request assertion proves the mutation, and the CLI warns separately
so a consumer can inspect the freeze and add evidence for the intended outcome. **The marker alone
MUST NOT become a failure gate without additional evidence:** a correct on-page save also consumes
the bounded observation budget and carries it. User assertions are never stamped.
The advisory stamp itself does not alter the destination, baseline `vacuous` flags, step expects,
request proofs, or replay verdict semantics; the completed observation can ground a newly observed
destination and its step expect. `SuiteVerdict.observedBeforeLastMutation` and the freeze trace payload summarize
the marked destinations as an optional `string[]`, derived from the scenario's assertions and
absent when none are marked. Fresh discovery, cached replay, outcome-heal re-freeze, `onCase`,
the suite CLI and its report carry the same advisory. Outcome-heal retains the original goal
assertions and their provenance, so its summary describes those preserved checks.

The bounded wait mitigates short response-to-redirect races; it cannot establish navigation
completion or causation. A redirect beyond the budget, or a later hop after reaching a different
path, can still escape the observations. Locale/wildcard equivalence applies to the advisory,
while the wait compares concrete host+path destinations. A different resource path can therefore
end the wait yet still carry an advisory when the frozen generalized destination also matched
before the mutation. These limits do not change replay verdict semantics.

## Perception's role (P6)

Three layers are *captured*, but the deterministic verdict rules on **two** — execution + logic.
`Evidence.perception.screenshot` is **not judged by built-in critics**; it feeds the host's visual
replay and is available to `custom` checks. LLM-vision assertions (a critic that reads the screenshot)
are a future step — the claim is "three captured, two judged", not "three judged".
