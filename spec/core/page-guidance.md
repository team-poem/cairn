# Host page guidance bound to a decision observation (#304)

## Contract and boundary

`pageGuidance?: PageGuidanceProvider` is an optional host callback on `discover` and `explore`.
It returns short advice for **one** decision observation: where the page is, what a control on it
does, what is invisible. Static application knowledge stays in [app context](app-context.md); the
two are passed, labeled, budgeted and recorded separately. Without a provider nothing changes: no
extra Driver read, no prompt change. A configured provider that returns nothing costs one URL read
per `discover` turn and leaves the prompts unchanged.

```ts
type PageGuidanceProvider = (request: PageGuidanceRequest) => string | undefined | Promise<string | undefined>;
interface PageGuidanceRequest {
  purpose: "discover" | "explore";
  observationId: string;          // the engine's temporary observation ID, never a Driver ref
  url?: string;                   // read immediately before this observation's capture
  elements: readonly PageGuidanceElement[]; // role, name, nth?, checked?, disabled?, inActivePopup?
  signal: AbortSignal;
}
```

The engine never calls a model, drives the browser or fetches anything to obtain guidance. A
provider must not do either on the engine's behalf; the engine cannot stop a host that does.

## When it runs

Per loop turn, in this order:

1. Settle. **URL read**: `discover` adds one `observe()` here only when a provider is configured;
   `explore` already reads it here.
2. Capture, `perceive`, selection and reference issuance (`PerceptionObservation`). A rejected
   capture never reaches the provider.
3. The policy `stop` check. A stop never calls the provider.
4. **Provider**, given this observation's listed rows and the URL from step 1.
5. Decision prompt built from the same observation, the prepared-selection trace event, model dispatch.
6. Bind, then validate accepted guidance before any decision effect, including `done` and
   exploration `note`. Check the URL. For a decision without an exact reference, also capture
   fresh elements, compare their semantic/perception state, and read the URL again after capture.
   A reference-bearing action retains the Driver's exact-node mutation guard instead of taking
   a new snapshot that would invalidate its reference.
7. Ambiguity gate, pre-dispatch URL check, policy vet and dispatch. Existing action evidence
   watermarks remain at their existing boundaries.

The provider is called once per observation that reaches a decision prompt. Guidance lives in that
turn's local scope; nothing carries it to another observation.

## URL consistency and invalidation

The URL read and the capture are separate Driver calls; attaching an observation ID does not make
them atomic. The decision is guarded instead: when guidance was attached and the pre-dispatch URL
differs from the URL given to the provider, the decision is not dispatched. The loop records a
failure line for the next decision, emits `gate: page-guidance`, and recaptures. A Driver that
reports no URL gets no navigation invalidation; observation binding still applies.

For policy completion checks, guided discovery prefers the current observed URL and falls back
to its last-known URL when the Driver omits `finalUrl`, including the check after the expiration
limit. If neither is known, the policy still receives `undefined`. This fallback does not replace
the actual URL sent to the guidance provider or compared during guidance validation.

Same-URL changes such as an overlay opening invalidate reference-free decisions when fresh
capture differs in role, name, value, checked/disabled state, active-popup/occlusion/clickable
facts, or row order. The original comparison state is copied before the provider runs, so a
host mutation of a returned array cannot rewrite it. Driver refs and local clickable-region IDs
are excluded because they can rotate without a semantic change. This state is run-local and is
never traced or hashed. A mismatch drops the decision and asks for a fresh observation next turn.

Exact reference actions use the existing Driver mutation guard and `assertDecisionCurrent`;
no extra snapshot rotates those references. Drivers must honor their exact-node contract.
For reference-free decisions, comparison is an observation-boundary check, not an atomic lock:
unobservable changes, a change that reverts before validation, and changes after validation can
still race. A navigation that returns to the same URL (A to B to A) is likewise not detectable
from URL equality. These limits are explicit; an observation ID is not proof of atomic capture.
A new turn always receives a new observation and a new provider call.
Late guidance cannot authorize anything: a value arriving after the timeout is discarded, and no
guidance ever reaches binding, ambiguity, `ActionPolicy`, target validation or grounding.

## Repeated expiration (#340)

Each `discover`/`explore` invocation allows `MAX_PAGE_GUIDANCE_EXPIRATIONS` (3) expirations
without a successfully executed action. Initial observation/URL validation and the later
pre-dispatch URL check contribute to the same counter, once per rejected decision. Once the
bound is reached, no further decision model request is made. The result is incomplete:
`truncated: true`, `truncationReason: "page-guidance-expired"`. This is not goal completion or
an observed application defect, and it never authorizes executing a rejected decision.

Only successful executable actions reset the count, including actions taken without guidance
after a provider fallback. Recapture, parse/binding/ambiguity failures, policy rejections,
failed dispatches and exploration notes do not reset it. Empty, failing, invalid or timed-out
providers do not increment it. They retain the existing no-guidance fallback. A valid `done`
can finish normally before the bound; expired `done`/`note` decisions count like expired actions.
Each call starts at zero, even when a provider, policy or workflow budget is reused.

Trusted `policy.stop` has priority on a valid observation. If the bound was reached and a
`stop` callback exists, one additional observation-only goal check is allowed, including at
the general step cap. This check uses a perception snapshot, the host's `perceive` corrections
and discovery's secret-value redaction even for a stop-only policy. No provider or decision
model is called for it. Invalid bindings leave
the run incomplete. Otherwise the expiration reason takes precedence over simultaneous scroll
policy suspicion; the scroll counters are neither changed nor emitted as guidance diagnostics.
A smaller general step cap that stops before three expirations retains ordinary truncation.
Exploration retains the latest known URL and visited destinations from the validation reads,
including when the third expiration ends the loop without another observation. These remain
report fields, not guidance diagnostics; retaining them adds no browser reads.

Discovery still finalizes prior actions and evidence through its existing assertion-proposal
call. With no tighter bound, three expired decisions therefore cost four model admissions;
exploration costs three. All calls share the original execution budget. Cancellation or budget
exhaustion, including at the final proposal, retains its own terminal behavior and does not
publish a guidance-expiration result. A terminal guidance trace is emitted only after successful
finalization. Previously executed actions are not restarted or retried.

After an expiration, retry advice is built from the next observation's actual `hasReferences`.
It suggests fresh refs for target-bearing actions only when available, without bypassing any
binding, description, policy or Driver mutation check. Reference-free Drivers remain supported,
and the bound works even when the model ignores this advice. Healthy and no-guidance paths add
no browser reads or model calls.

## Supported paths

| Path | Receives page guidance? |
| --- | --- |
| `discover` decisions | Yes |
| `explore` decisions | Yes |
| Inline `done` assertions in a guided decision | Discarded, with a gate; the unguided proposal call still runs |
| Discovery assertion proposals | No |
| Final semantic critic | No |
| Outcome re-discovery, surgical step repair, locator repair, target choice | No (`runScenario`/`runSuite` do not accept the option) |
| `runSuite` discovery on a cache miss, CLI | No |
| Deterministic replay | No; no provider call and no model request |

Guidance is added to the decision prompt itself, not to an `LlmClient` wrapper, so a proposal or
judgment call cannot receive it through a shared client. Repair paths may be added later through
the same request shape; each needs its own invalidation point before dispatch.

## Failure, timeout, cancellation, caching and size

- **Failure.** A thrown or rejected provider, or a non-string result, means no guidance for that
  decision. The decision proceeds and the trace records a fixed reason. The error is not echoed.
- **Timeout.** `PAGE_GUIDANCE_TIMEOUT_MS` (5,000 ms), fixed, matching the target-selection
  timeout. On expiry the request signal aborts, the engine stops waiting, and the decision proceeds
  without guidance. A monotonic elapsed-time check expires either provider settlement after the
  deadline when synchronous work delays the timer. JavaScript cannot interrupt that callback;
  the check runs when control returns. Caller cancellation retains its original reason.
- **Cancellation.** Caller cancellation or run-deadline expiry aborts the request signal and
  rejects the run with the original reason or `BudgetExceededError`, as elsewhere. It is not
  converted into "no guidance".
- **Caching.** The engine does not cache. A host may cache inside its provider.
- **Size.** `MAX_PAGE_GUIDANCE_BYTES` is 4,096 UTF-8 bytes, checked on the raw value and again
  after secret slotting. Oversized output is rejected whole, never truncated. Whitespace-only or
  `undefined`/`null` means absent. Outer whitespace is trimmed.

## Deadline accounting

With a run `budget`, the provider runs inside the existing run scope as operation
`page-guidance.provide` (the same mechanism as `context.provide`). Its time counts against the
run's `timeoutMs` from the original start; nothing resets the allowance. It consumes no model-call
admission because it is not a model call. Without a budget, only the fixed timeout applies.

## Visibility and secrets

The provider sees only the rows the model sees for that decision, in listing order after
`perceive` and selection: role, name, duplicate ordinal and the `checked`, `disabled` and
`inActivePopup` states. It does not see Driver refs, input values, raw or unselected candidates,
evidence, history, the intent or any prompt. Configured secret values are replaced with their
`{name}` placeholders in names and the URL before the call, and in the returned text before it is
sent. This is value substitution, not sanitization: accessible names and URLs are page content and
can still carry personal or unregistered sensitive data. `explore` has no secret input.

## Trust separation

Guidance is a JSON string in its own section, labeled host-authored and not page content or
evidence, placed after the listing and references and before the final instruction. When it is
attached, the system prompt says guidance cannot establish a target, a successful action or a
check, and that the current page wins on conflict. Page content in element names stays data under
the existing perception rules. A host that copies page text into guidance gives that text the
host label; the engine cannot tell. Neither source overrides policies, the intent, target
validation or required proof. Prompt wording is not a security boundary.

## Provenance, identity and caching

Guidance never enters `Scenario`, `Scenario.provenance`, the judgment-contract fingerprint, suite
`caseHash` or any cache key. `appContextHash` is computed exactly as before. With identical model
replies, a guided and an unguided discovery freeze identical scenarios. Guidance changes what the
model chooses, so a different frozen path is still possible and is identified by its own steps.
The optional `truncationReason` describes authoring termination; it contains no advice or page data
and is not a new judgment input.

## Trace

Trace 1.13 adds `gate: page-guidance` with fixed reasons only:

- `page guidance unavailable: provider failed` / `provider timed out`
- `page guidance rejected: provider output is not a string` / `output exceeds 4096 UTF-8 bytes`
- `page guidance expired: the page URL changed after the guided observation`
- `page guidance expired: the page elements changed after the guided observation`
- `page guidance: assertions proposed in a guided decision were not used`

Trace 1.15 adds a terminal `page-guidance` gate with fixed reason
`page guidance expired repeatedly before an action could complete`, code `page-guidance-expired`,
`expirations: 3` and `limit: 3`. Results and `case-end.truncationReason` use the same reason code.
No new application finding or fabricated scroll `no-progress` event is produced.

No guidance text, hash, length, request or URL enters a trace payload. A model can still echo
guidance into a decision `reason`, which existing action events record; keep guidance nonsecret.

## Verification and limitations

`packages/harness/test/page-guidance.test.ts` covers a two-page flow with frozen replay and zero
model calls, a silent provider leaving prompts unchanged, same-URL overlays between turns and
while guidance/model work is pending, obsolete completion/notes/name-based actions, a URL change
during the provider call, slow, failing and cancelled providers, the run deadline, size bounds, secrets
and value exclusion, static and dynamic context together, a guided `done` that cannot author
frozen checks, and exploration. They use scripted
models and a stub Driver. This is contract coverage, not a measurement of discovery quality.

For the real Chrome/MCP fixture, run `npm run build && node scripts/test-page-guidance.mjs`.
It discovers two pages using exact-node actions and replays the frozen path with zero model calls.
The fixture uses a local HTTP server and scripted decisions; no model account is required.
`CAIRN_MCP_ENTRY` may select an installed MCP 1.8.0 entry point.
`page-guidance-expiration.test.ts` covers bounded instability, mixed failures, reset semantics,
trusted completion, cancellation and shared-budget accounting with scripted Drivers/models.

Run `node scripts/test-page-guidance-expiration.mjs` after the build for the reference-free
Chrome/MCP fixture. Its local app changes a countdown between the decision and validation,
then acknowledges the DOM update. Continuous changes must stop both loops after three expired
decisions with no click; one transient change must recover and complete. These scripted cases
verify engine behavior, not model quality, and use the same MCP entry-point override as above.
