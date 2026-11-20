# Host page guidance bound to a decision observation (#304)

## Contract and boundary

`pageGuidance?: PageGuidanceProvider` is an optional host callback on `discover` and `explore`.
It returns short advice for **one** decision observation: where the page is, what a control on it
does, what is invisible. Static application knowledge stays in [app context](app-context.md); the
two are passed, labeled, budgeted and recorded separately. Without a provider nothing changes: no
extra Driver read, no prompt change. Without a scope, a configured provider that returns nothing costs one URL read
per `discover` turn and leaves the prompts unchanged.

```ts
type PageGuidanceReply = string | { text: string; freshness: "declared-scope" } | undefined;
type PageGuidanceProvider = (request: PageGuidanceRequest) => PageGuidanceReply | Promise<PageGuidanceReply>;
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
5. If the provider returned usable guidance, check the URL again before calling the decision
   model (#344). If it differs, discard this observation without calling the model, emitting
   a prepared-selection event or dispatching an action. A retry starts with a new capture
   and a new provider call. Otherwise emit the prepared-selection event and call the model.
6. Bind, then validate accepted guidance before any decision effect, including `done` and
   exploration `note`. Check the URL. By default, for a decision without an exact reference also capture
   fresh elements, compare their semantic/perception state, and read the URL again after capture.
   A reference-bearing action retains the Driver's exact-node mutation guard instead of taking
   a new snapshot that would invalidate its reference.
7. Check ambiguity, URL and policy before dispatch. For a click using a declared scope, a fresh
   scope measurement resolves the target and the Driver checks the receipt before input (below).
   Existing action evidence watermarks are unchanged.

The provider is called once per observation that reaches a decision prompt. Guidance lives in that
turn's local scope; nothing carries it to another observation.

## URL consistency and invalidation

On a stable guided turn, the pre-call check adds one `driver.observe()` and no element snapshot.
The engine uses only `execution.finalUrl`, but the cost depends on the Driver: the Chrome adapter's
`observe()` reads pages, network requests and console messages in parallel. This check adds no read
for absent or rejected guidance. It cannot prevent navigation during the model call, so the
post-response and pre-dispatch checks still run.

At each URL check, compare the raw observed URL with the one associated with the guidance.
If only one read has a URL, the mismatch expires the observation. If neither has a URL,
the URL check alone cannot detect a change; proceeding does not establish freshness.
On mismatch the loop emits a `page-guidance` gate; the next decision uses a fresh observation.
For a guided decision or a retry after expiration, the prompt's `Current page` line uses that
turn's entry URL, or `(unknown)` if the Driver omitted it. This also applies when the provider
returns no guidance on the retry. Policy checks and the exploration report can still use the
last known URL.

For policy completion checks during guided discovery, retain the latest defined URL separately
from the prompt's URL. Start with a successful base navigation, then update it from the baseline,
turn entry, scroll-policy, pre-call, post-response and pre-dispatch observations in that order of
execution. A missing `finalUrl` does not erase a newer URL already observed, even when validation
rejects the decision. If no URL is known, the policy still receives `undefined`.

The final check after the guidance expiration limit uses the same retained URL when its fresh
observation omits `finalUrl`. An ordinary step-cap check keeps its existing behavior, including
passing the raw observed URL to a `needsScrollState` policy. Unguided policy behavior and prompt
URLs are unchanged. Retaining a URL adds no Driver reads and never replaces the raw URL sent to
the guidance provider or compared during guidance validation.

With the default whole-observation comparison, same-URL changes such as an overlay opening invalidate reference-free decisions when fresh
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
advice text ever reaches binding, ambiguity, `ActionPolicy`, target validation or grounding.

## A declared freshness scope for a click (#356)

Use this when the host knows which controls a click depends on. For example, a checkout decision
may depend on the selected delivery and every row's checkbox, but not on a promotion. The engine
has no rule about banners: a host could include a promotional control when its state matters.

```ts
await discover("Check out the selected rows", {
  driver, llm,
  pageGuidanceScope: {
    target: { role: "button", name: "Checkout" },
    prerequisites: [
      { role: "combobox", name: "Delivery" },
      { container: { role: "list", name: "Cart rows" }, memberRole: "checkbox" },
    ],
  },
  pageGuidance: ({ url }) => url === cartUrl
    ? { text: "Use Checkout for the selected rows and delivery.", freshness: "declared-scope" }
    : undefined,
});
```

The option says what the Driver must measure **before** the provider or model runs. The reply
opts **this observation** into the comparison. On the next turn the Driver measures again and the
provider chooses again. A plain string always uses the existing checks. A tagged reply without
a configured scope also uses those checks. The provider does not receive IDs or extra page data.
Declaring a scope costs a scoped capture even on turns where the provider returns nothing.

Only a reference-free `click` with the target's exact role and name and no `nth` can use this
comparison. The target must be unique and present in the model's listing. Exact refs keep their
existing guard. All other reference-free decisions, including `done` and `note`, still compare
the whole observation. The declaration does not constrain which actions the model may propose;
use an action policy for that.

An individual prerequisite must match exactly one control. A set selects every member of one
role under one named container, in document order. There are no name patterns or selectors.
Different runs can have different sets. Within one decision, losing or replacing the container,
replacing or reordering a member, changing its measured state, or disabling or covering the target
prevents the click. Equal counts do not establish equal membership. Missing or ambiguous
prerequisites, empty sets and incomplete measurements cannot authorize a click. The declaration
accepts 1–16 prerequisites; a capture covers at most 256 distinct target and prerequisite nodes.
A malformed declaration with a configured provider throws before the first browser operation.

Drivers opt in with `snapshotWithGuidanceScope`, which returns both the perception listing and
scope facts from the same observation. Facts must cover every match and relevant state; IDs must
identify actual nodes across captures within one document. Identically named replacements need
new IDs. The engine copies the original facts, checks the policy, then asks for a fresh scope
measurement and checks its URL. It does not call the ordinary name-based `locate()` for this
click. The fresh measurement must return a nonempty `targetRef` bound to the measured target
**and all prerequisites**. The Driver must revalidate that receipt before sending input, including
changes made while the engine was checking the URL. Facts without a receipt cannot authorize a
scoped click.

If the Driver lacks this capability or cannot measure the scope on this page, a matching scoped
click does not run, even if the screen looks unchanged. Three expirations without a successful
action end the run with `page-guidance-expired`. There is no automatic fallback: two rows can
look identical even though one replaced the other. On a page where the ordinary comparison is
appropriate, the host can return a plain guidance string instead of the tagged reply. The
presence of the Driver method alone does not establish coverage for the current page.

The receipt is for dispatch only; it is never sent to the model or frozen. The saved click uses
the target's confirmed role and name. It has no positional fallback from a prior layout, so a
later rename may require repair. If the target disappears or becomes ambiguous, no click runs
and the rejection counts toward the normal three-expiration limit.

Once the Driver passes its final pre-send check, a click can take effect even if the Driver
then reports an error. For an ordinary click error after that point, both loops stop without
retrying and return `truncated: true` with `truncationReason: "click-dispatch-uncertain"`.
The result contains the confirmed steps, not the unacknowledged click. Discovery returns no
assertions and does not read the page to derive step expectations: the last click could have
caused the navigation or request. Exploration keeps findings it already recorded and the last
URL it observed before dispatch. The uncertainty is not itself an application finding.
For example, an MCP click error can mention an open confirmation dialog even if input
never reached the button. Chrome does not accept a dialog or record a successful scoped
click on the strength of that error.

An observation failure before input is not an uncertain click. Connection loss, caller
cancellation and run-budget exhaustion still propagate as errors, including after dispatch.

Chrome supports `<button>` click targets (not `<input type="submit">`), native single-select,
checkbox and radio prerequisites, and checkbox sets in named lists or groups in the top-level
light DOM. For native checkboxes, it compares the underlying `checked` value separately from
`indeterminate`: two controls that look mixed can submit different values. An adapter that only
observes the mixed accessibility state cannot attest to a stable submission value.

Before sending input, Chrome takes a fresh accessibility snapshot and compares its matches with
live DOM nodes in document order. It checks their identity, the prerequisites' current state and
whether the target can receive the click. A newly visible duplicate can fail this check even
if only a CSS rule changed. An unrelated text update need not settle first. If Chrome cannot
establish the match (for example, a frame, an unsupported accessible name or more than 4,096
elements to inspect), it withholds the click. Hosts should use this feature only for controls
and potential matches in the top-level light DOM. Page JavaScript cannot enumerate the contents
of a closed shadow root, so this contract does not cover changes hidden there after the last
accessibility snapshot.

The Driver checks cancellation and the run deadline after validation, immediately before sending
the click request. Validation and browser input are separate MCP operations; the page can still
change after the last measurement.

Node identity and measured control state cannot distinguish a recycled DOM row whose application
data changed without any observable change. The host must establish
application-specific readiness **before** supplying scoped advice: even a consistent, nonempty
list may still be loading. No snapshot proves that an omitted dependency is ready.

## Repeated expiration (#340)

Each `discover`/`explore` invocation allows `MAX_PAGE_GUIDANCE_EXPIRATIONS` (3) expirations
without a successfully executed action. Pre-call URL checks, post-response validation and
pre-dispatch URL checks contribute to the same counter, once per expired turn. A pre-call
mismatch uses one iteration of the ordinary step limit even though it makes no decision call.
Once the bound is reached, no further decision model request is made. The result is incomplete:
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
call. If all three turns expire before the model call, discovery makes only its final proposal
call; exploration makes no model calls. If all three expire after the response, discovery makes
three decision calls and one proposal call; exploration makes three decision calls. These examples
assume three consecutive expired turns and no other decisions. All calls share the original
execution budget. Cancellation or budget exhaustion, including at the final proposal, keeps its
own terminal behavior and does not
publish a guidance-expiration result. A terminal guidance trace is emitted only after successful
finalization. Previously executed actions are not restarted or retried.

After an expiration, retry advice is built from the next observation's actual `hasReferences`.
It suggests fresh refs for target-bearing actions only when available, without bypassing any
binding, description, policy or Driver mutation check. Reference-free Drivers remain supported,
and the bound works even when the model ignores this advice.

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

- **Failure.** A thrown or rejected provider, or a result other than text or a supported scoped reply, means no guidance for that
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
`caseHash` or any cache key. `appContextHash` is computed exactly as before. For identical replies,
executed steps, evidence and completion, the frozen scenario is the same. Guidance changes what the
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

Trace 1.16 adds `scopeStatus` to discarded scoped clicks: `scope-changed`, `target-ambiguous`
or `scope-unverifiable`. When known, `targetUnambiguous` describes target resolution. Counts
compare stable node IDs: added/removed IDs and retained IDs whose measured state or position
changed. No count is guessed across documents or replaced containers. Outside counts are optional:
they require a complete measured complement in both captures, and do not trigger another read.
Omitted counts mean unavailable, not zero. If the scope can still be measured, a change only
outside it does not expire the click.
An uncertain dispatch emits a terminal `page-guidance` gate with code
`click-dispatch-uncertain`. It carries no Driver error message or scope-change counts.

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
`page-guidance-preflight.test.ts` counts `observe()` calls between the provider and the decision
model in both loops: one on a stable turn with accepted guidance, zero on a turn with empty
guidance. This measures Driver calls, not live browser latency.

Run `node scripts/test-page-guidance-expiration.mjs` after the build for the reference-free
Chrome/MCP fixture. Its local app changes a countdown between the decision and validation,
then acknowledges the DOM update. Continuous changes must stop both loops after three expired
decisions with no click; one transient change must recover and complete. These scripted cases
verify engine behavior, not model quality, and use the same MCP entry-point override as above.

Run `node scripts/test-scoped-page-guidance.mjs` after building for scoped clicks. In both
`discover` and `explore`, the local cart rotates a promotion every 30 ms and also changes its
text during capture. The test checks that the timer is still running when the Checkout handler
fires, and counts both click requests and actual button clicks. Separate cases introduce a
same-name button (including with CSS between the last accessibility and DOM reads), replace the
target or change a checkbox's underlying value while it still looks mixed. Each rejected decision
must send no click and save no step. The fixture also moves an unrelated button and replays
the frozen Checkout step with no model calls. A separate case lets Chrome click Checkout and
navigate to the receipt, then injects an error in the click response. Both loops must return
the earlier Start step without the receipt URL as its expected outcome. Scripted Driver tests in
`page-guidance-scope.test.ts` cover both decision loops; `guidance-scope.test.ts` checks
identity, ordering and content-free diagnostics.
