# App context PoC in an internal Cairn-based QA extension

For [#252](https://github.com/team-poem/cairn/issues/252), we tested whether a short
app description reduces discovery work in an existing internal agentic testing
extension built on Cairn. The experiment ran in the QA project, using its normal
browser driver and discovery workflow. This is a results report, not an engine
implementation or a decision on a cairn.txt format.

The September 29, 2026 handoff provides anonymized observations. Company identity,
accounts, URLs, product identifiers, source code, raw logs and screenshots are
excluded. This report covers the extension experiment only; earlier synthetic-demo
and other-provider trials are not pooled with it.

## Setup

- Existing Chrome MV3 extension and custom CDP driver. Cairn 2.9.2 was reported
  from the local installation, not an engine-version field in the export. All
  eighteen retained records and replay sources report the same consumer build.
- Codex CLI 0.158.0, requested `gpt-5.6-terra`, medium reasoning, ephemeral sessions
  and common configuration isolation, with CLI automation tools disabled.
  Discovery was capped at 32 LLM-port calls, with a 180-second bridge timeout per
  request, no configured output-token cap and no consumer automatic retry.
- A: existing QA guidance. B: the same guidance plus a host-provided six-sentence
  app description. Task, driver, policies, account setup, secret handling, page
  guidance and verification implementation stayed fixed.
- The description covers app purpose, products/options/quantities, account-bound
  sessions and carts, and adding to cart versus ordering/paying. It gives no
  selectors, addresses or click sequence, and does not replace live observation.
- Context reaches decisions and assertion proposals, but never frozen replay.
  The CLI receives the system option as a text block in stdin, not a verified API
  system-role message. This tests additional context on top of existing guidance,
  not an uninformed agent against an informed one.

The tasks were to sign in and verify the account, choose an available product and
verify one unit in the cart, and choose an available product and verify two units.
The agent selected products and any required options through the UI. Direct
guessed-address navigation and ordering/payment remained prohibited.

There was one discovery per task and condition, always B then A, followed by two
raw frozen replays per discovery: six discoveries and twelve replays.

## Discovery results

Each discovery includes one assertion-proposal call. Calls count QA LLM-port/CLI
invocations, not internal API requests. Time includes automated preparation,
model waits, actions, verification and cleanup, but excludes manual preparation.
Input tokens include CLI instructions and cache reads; cache reads are not added
again. Internal CLI request counts and retries are unmeasured.

| Task | Context | Decision calls | Total calls | Seconds | Input tokens | Output tokens | Gates |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Login | Off | 5 | 6 | 38.454 | 79,325 | 249 | policy: 1 |
| Login | On | 5 | 6 | 36.877 | 79,891 | 230 | policy: 1 |
| One unit | Off | 20 | 21 | 161.936 | 278,207 | 1,965 | ambiguity: 1 |
| One unit | On | 16 | 17 | 110.457 | 223,041 | 1,132 | none |
| Two units | Off | 20 | 21 | 153.044 | 276,067 | 1,906 | none |
| Two units | On | 19 | 20 | 135.710 | 265,831 | 1,731 | idle-scroll: 1 |
| Total | Off | 45 | 48 | 353.434 | 633,599 | 4,120 | 2 |
| Total | On | 40 | 43 | 283.043 | 568,763 | 3,093 | 2 |

In this retained sample, the context condition used 10.4% fewer total calls, 11.1%
fewer decision calls, 19.9% less time, 10.2% fewer input tokens and 24.9% fewer
output tokens. Gates did not decrease. Most of the difference came from product
exploration: login calls were unchanged and its input tokens slightly increased.

All six discoveries report complete state, with no failed calls, refusals,
truncated responses or budget rejections. Complete state alone is not independent
confirmation of the full task outcome.

## Frozen replay and verification

The extension replayed raw scenarios captured before host correction, without
context, healing, reanchoring or host proof correction. Model communication was
blocked and attempted requests were counted.

| Task | Steps per replay, both arms | Context off verdicts | Context on verdicts |
| --- | ---: | --- | --- |
| Login | 5 | 1/2 pass, work | 2/2 pass, work |
| One unit | 11 | 2/2 pass, work | 2/2 pass, work |
| Two units | 13 | 2/2 pass, work | 2/2 pass, work |

All twelve replays executed every step successfully, skipped none, and recorded
zero model calls and zero model-request attempts. Eleven passed the final verdict
with work proof. The first context-off login replay failed only
`no-console-errors`; the login request and final account check passed. The console
failure's cause is unresolved, not assumed to be harmless noise.

Independent account checks pass for login discovery and all four login replays.
Product runs show newly added IDs reflected in the cart, but exact selected
product/option/quantity checks remain unimplemented (`goalOracle=null`). Work proof
does not fill that gap. Generated assertion sets also differ: the one-unit context
arm adds a failed-request guard absent from its baseline. Because context reaches
assertion proposals, verification equivalence cannot be inferred from proof alone.

## Interpretation

This small real-use PoC gives a directional signal that a short app description
can reduce discovery effort in an existing Cairn integration. It is not a general
causal-effect estimate or proof of unchanged success and verification quality:

- Each task has one discovery per condition, always context first. Replaying a
  frozen scenario twice is not two independent discovery repetitions.
- The export reports 68 deleted records and `incompleteHistory=true`. Their
  relationship to these trials cannot be established, so the analysis covers only
  the retained eighteen records, not all historical attempts.
- Session preparation reports ready, but cart clearing was manual without an
  independent empty-state check. Identical initial carts, chosen products,
  inventory and server state across arms are not independently established.
- Exact product/option/quantity verification is missing and assertion sets differ.
- Actual dollar costs remain unknown (`measuredCostUsd=null`). Assumption-based
  API-equivalent estimates are omitted; subscription usage is not zero-dollar
  execution, and token changes do not establish measured dollar savings.

The experiment is concluded. These observations can inform discussion of optional
host-provided descriptions, without requiring further runs as part of this report.
They do not settle #252's full adoption criterion or commit Cairn to a file format
or API. The submitted change is documentation only, with no experimental code.
