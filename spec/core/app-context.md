# Host-provided app context (#282)

## Contract and boundary

`appContext?: string` is optional reusable app knowledge: terminology, prerequisites, and the
difference between operations. The host supplies it. The engine never fetches it from the app,
searches the filesystem, or invents a description. It is separate from the task/charter, live
observations, accumulated execution history, policies and criteria.

The initial contract is deliberately text-only. `validateAppContext` rejects nonstrings and input
over `MAX_APP_CONTEXT_BYTES` (16,384 UTF-8 bytes, before trimming), without echoing the value.
Whitespace-only input means absent. Outer whitespace is trimmed; internal whitespace is retained.
There is no silent truncation. The bound is also checked after secret substitution, which can
expand a short value to a longer placeholder. It limits prompt overhead, not tokens or run cost.
Configured secret values are replaced with their existing placeholders before sending or hashing
the description on paths supporting secrets. Matching uses the original text before trimming,
including leading/trailing whitespace that belongs to a secret. The CLI preserves that text until
engine substitution; `validateAppContext` alone normalizes text and does not redact credentials.
Do not put credentials in app context; exploration
has no secret input and the engine cannot identify unregistered secrets.

Snapshot boundaries:

- `discover` and `explore`: synchronously at function entry, before driver/model work.
- `runScenario`: at entry, reused by locator repair, surgical repair and outcome re-discovery.
- `runSuite`: each case receives its own value before loading the cache. Discovery, replay and
  repairs for that case share it. Changing the options between cases affects the next case only.
  The case also copies secret values and scopes, so host-side credential rotation cannot change
  description substitution between discovery and repair. Scoped fields are read by name, including
  inherited fields and getters, and captured as plain values. Raw text is retained internally rather
  than passing already-substituted text through substitution again. Initial input is validated
  before any trace/store/driver/model callback, and each subsequent case validates its new input
  before cache or execution work. Invalid configuration rejects the suite, not an app verdict.
- Browser consumers constructing `SelfHealingDriver` or `LlmStepHealer` directly: construction
  captures the value. Construct a new instance per run; reusing one also reuses its repair budget
  and context. To compose multiple phases manually, supply the same captured string to each.
- CLI: `--app-context <file>` explicitly reads one regular UTF-8 local file before execution and
  supplies its contents through this API. The command does not reread it between suite cases.
  Nonregular files are rejected; opening a FIFO does not wait for a writer.

There is no resolver callback, format inference, mandatory filename or automatic reload.
Per-decision advice tied to the current page is a separate seam, [page guidance](page-guidance.md). Hosts
that need a file, database, or asynchronous provider resolve it before invoking the engine.

## Model-call routing

| Path | Receives app context? |
| --- | --- |
| Discovery decisions, including retries | Yes |
| Discovery assertion proposals | Yes; proposals still require observed evidence |
| Exploration decisions/notes | Yes |
| Legacy locator repair | Yes |
| Surgical step repair | Yes; original intent and expect remain intact |
| Outcome re-discovery and its assertion proposals | Yes; final judgment uses original assertions |
| Final semantic critic | No |
| Finite-choice targetChoice/Jev pilot | No; its existing protocol is unchanged |
| Deterministic replay | No model request |

The LlmClient wrapper is scoped to authoring/repair only. App context is a JSON-encoded string in
a separately labeled prompt section. System guidance describes it as potentially stale background,
not live evidence, permission, or a replacement for the task. Absence returns the original client
and leaves existing prompts unchanged. Usage callbacks and completion options pass through.

`ContextProvider` continues to supply the replay pipeline's task context. It is also visible to a
critic and can be reported in results, so it is not used as storage for the raw app description.
Consumers may resolve both inputs from the same host service, but pass them separately. Custom
planners, injected critics and external repair adapters are host-owned; this feature does not
rewrite their prompts. Browser `runHarness` has no new automatic app-context phase: wire its
existing healer/driver seams explicitly, or use `discover`/`explore` from the browser entry point.

## What guidance cannot authorize

ActionPolicy remains the executable boundary. Observation-local binding and evidence grounding
are unchanged. A stale description cannot establish a target, a successful request or a passing
assertion. Outcome repair must satisfy original goals; its newly proposed checks never replace
them. An unknown or failed goal cannot become a verified repair because a description says so.
Context does not upgrade a locator repair into proof of success: inspect the returned verdict
and existing repair semantics. No new action, fallback, budget, or model judge is introduced.

Prompt instructions are not a security boundary. Scripted verification demonstrates propagation
and enforcement, not model quality or resistance to every prompt injection. A host using a
model-dependent assertion still owns the judge and its `judgmentKey`.

## Identity, cache and persistence

New discovery records `Scenario.provenance.appContextHash` using #196's UTF-8 SHA-256 helper over
the normalized, secret-slotted description. No new fingerprint type is introduced. When context
is absent, provenance is absent. If WebCrypto is unavailable, omit provenance rather than invent
a hash or block execution; existing contract completeness rules still apply.

Changing context alone does not change a judgment-contract fingerprint or suite `caseHash`.
It does not invalidate cached scenarios or force a model request. A frozen replay may be run with
no description, a changed description, or a legacy scenario with no context metadata. Its verdict
continues to reference the scenario's historical provenance, not the current input. Assertions
authored differently under new guidance can of course produce a different contract.

Outcome re-discovery creates a new artifact with the context actually supplied to that discovery,
or no provenance when none was supplied. Legacy locator/surgical repairs supplied with context
stamp their returned artifact with that current hash; the input scenario and historical verdict
are unchanged. When no context is supplied, locator/surgical repair retains the existing behavior
of preserving original creation provenance. The targetChoice pilot preserves it as before.
The returned artifact's provenance describes its latest context-assisted creation/repair, not a
complete ancestry chain. Hosts own retaining old artifacts and linking repair history.

The engine adds no raw-description field to Scenario, Result, ExploreReport or trace events.
It sends the description to the configured model provider. Providers may log prompts; models may
echo text in reasons or proposals which the existing event stream records. This is not a guarantee
that arbitrary sensitive prose can never appear in downstream output. Keep descriptions nonsecret
and configure the provider/sink appropriately.

## Verification and limitations

`test/app-context.test.ts` covers validation, snapshots, all supported phase routing, policy and
grounding, unchanged healthy replay, repair against original goals, legacy files, suite caching,
context provenance, and unavailable browser WebCrypto. `test/cli-app-context.test.ts` covers the
explicit file boundary, size bound and invalid UTF-8.

Run `npm run build && node examples/app-context.mjs` for a real Chrome example using the existing
local order demo. It compares scripted discovery with/without context, checks actual order payloads,
repairs a changed control, replays without model access, and rejects a server defect. No paid model
is used. It verifies wiring and safety, not discovery savings or healing quality. A broader paired
evaluation in a real consumer remains separate from this implementation's contract tests.
