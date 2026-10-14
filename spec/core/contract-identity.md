# Contract identity (#196)

Identity describes the declared judgment inputs, not whether the app passed and not a hash of the
execution script. It is advisory: it never changes assertions, verdict classification or replay.

## Two records, two responsibilities

- `Scenario.contract` records the identity at authoring/freezing time. `discover` stamps it; the
  suite recomputes it **after** merging user assertions. Hand-authored consumers use
  `identifyScenario(scenario, { intent })` before persisting.
- `Verdict.contract` is computed from the assertions actually submitted to the critic and the
  current declared judgment settings. Never copy a stored fingerprint without recomputing: a
  consumer may have edited assertions. Reporters and trace `case-end` receive that identity.
- `Scenario.provenance.appContextHash` identifies a host-declared creation input independently.
  Changing it alone does not change the judgment fingerprint. `Verdict.provenance` refers to the
  scenario judged, not today's app description. Only a SHA-256 digest is copied; no raw description.
  Loading and injection follow [app context](app-context.md); identity stays independent of guidance.

The engine does not rewrite stored records on replay. A returned repaired scenario is a new object;
the host/store owns retaining previous artifacts. A repair preserving all judgment inputs can have
the **same** contract fingerprint despite different steps. Outcome re-discovery is judged against
the original checks, not its newly proposed checks; its returned freeze is stamped after restoring
the original assertions and intent identity. It does not inherit an app-context digest for context
it was never supplied. Locator/step replacements preserve the source scenario's creation provenance
when no app context is supplied. A new context-assisted repair artifact records its current context
hash without altering the original scenario or the verdict's historical provenance.

## Version 1 material

`ContractIdentity` contains `version: 1`, a SHA-256 `fingerprint`, optional `intentHash`, and
`complete`. The digest material contains:

- the authoring intent's SHA-256 digest (no second raw copy of the intent);
- the full ordered assertion array, including params and provenance/vacuity stamps;
- wildcard interpretation;
- built-in judgment revision, benign request/console patterns, locale prefixes, allowed request
  hosts, and an optional host `judgmentKey`.
- for semantic or injected critics, a separate digest of the effective `Context.intent` supplied
  to that judgment. This never replaces the authoring-intent digest.

Built-in revision starts at 1. Change it when built-in judgment semantics change, not on every
package release. Custom check code, injected critics, semantic model/configuration, and external
evidence interpretation cannot be introspected. The host must version these through `judgmentKey`.
Without a nonblank key, a custom/semantic/injected judge yields `complete: false`. A generic
`runHarness` Critic is opaque by default; `judgment: { opaque: false, ...settings }` is an explicit
declaration that it uses the documented built-in semantics. Hosts must also version external
evidence maps even if their assertions use only built-in kinds.

The pipeline captures effective intent automatically, including the context fetched again during
outcome repair. Helpers accept `judgmentIntent`: a string is the supplied intent, `null` is known
absence, and omission is unknown. Semantic/injected identities stay incomplete until this input
is captured, even with a judgment key. Custom checks using the built-in custom handler receive no
Context, so they need no effective-intent hash. Changes during judgment make the verdict incomplete.

Display names, steps/targets, runtime limits, screenshots, credentials, observed evidence, current pass/fail
and app-context provenance are excluded. This is **not** an identity of every execution condition.
When a name supplies the default context intent to a semantic judge, that effective intent is
included: changing a label must not silently change the judge's instructions under the same identity.
Even a matching contract does not establish that a new failure is an application regression; inspect
failure classification, environment and evidence. Origin/vacuity/advisory assertion stamps are kept
conservatively: changing their stored declaration can change the identity even when pass/fail would
not change. Runtime replay reanchoring hashes the transformed assertions/settings; the canonical
freeze remains unchanged.

Canonicalization sorts object keys recursively, drops undefined object properties, keeps array order
and duplicates, and uses JSON string/number encoding followed by UTF-8 SHA-256. Configuration arrays
that are sets are sorted and deduplicated before canonicalization. Nonfinite numbers, undefined array
entries, cycles and non-JSON values are rejected by `hashContractValue` rather than silently colliding.
Automatic scenario identification handles unrepresentable inputs as incomplete, using a reserved
unavailable digest that must never be compared directly. Replay still executes the original custom
check with its original params, including Date, BigInt, functions or cycles. Custom params are
validated more strictly than optional metadata: explicit undefined fields (including nested ones),
accessors, symbols, non-enumerable properties, extra array properties and negative zero cannot be
silently erased or normalized, since a custom check can distinguish them. They yield `unknown`.
WebCrypto is used on both public entry points and makes no network call. When its digest API is
absent (for example, an engine embedded in a non-secure HTTP page), automatic identification returns
`complete: false` with a reserved all-zero fingerprint marker. It does not call WebCrypto again or
prevent traceless replay. `compareContracts` therefore returns `unknown`, even against another
unavailable marker. An existing authoring-intent hash may be retained, but an explicit new intent
never inherits the old hash. Direct calls to `hashContractValue` still require WebCrypto and reject
with a descriptive error when it is absent. This does not change the trace subsystem's pre-existing
random-UUID requirements.

## Unknown is not equal

Legacy files remain loadable. No original intent is invented from a display name or a current
ContextProvider. A replay can compute an incomplete structural identity without altering its file;
`compareContracts` returns `unknown` when either record is missing, incomplete, malformed or from an
unsupported version. Hosts may explicitly re-author a legacy file with `identifyScenario` and its
known intent, but must not backfill historical verdicts as though that identity had been recorded.

`compareContracts(a, b)` returns `same`, `changed`, or `unknown`. `same` compares complete declared
contracts only, not outcomes. Custom params retain their object identity for existing integrations;
if their contents change during a run, the verdict is marked incomplete rather than claiming one
fixed contract. Callers must not mutate judgment inputs while their check is running.

`caseHash` remains the suite's existing cache-staleness key over authored case inputs; it is not a
verdict fingerprint and does not replace `contract`. Its legacy encoding is unchanged, avoiding a
forced discovery of every cached file. `hashCase` is exported on the Node entry for existing users;
the new contract helpers are shared by Node and browser consumers.

## Storage and traces

The bare Scenario JSON format remains unchanged apart from optional metadata. File stores preserve
metadata without inventing or re-stamping identity on load/save. Use `identifyScenario` after editing
an authored scenario; the suite does this after merging assertions. Metadata hashes are identifiers,
not authentication or confidentiality mechanisms, and cannot reconstruct the original description.

Trace 1.9 adds optional `contract`/`provenance` to `freeze` and `case-end.payload.verdict`. Earlier
readers can ignore them; missing fields remain unknown. Preflight refusals/crashes with no completed
judgment may have no identity. No extra model request, browser action, or raw-context persistence is
introduced.

Consumer example: `examples/contract-identity.mjs`. After `npm run build`, run it with Node to see
same-contract app failure, changed checks, and unknown legacy identity without a model.
