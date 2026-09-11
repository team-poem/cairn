# Issue #203 — navigation evidence before the last mutation

Branch: `codex/203-freeze-redirect`, based on `develop`.

## Problem and choice

Discovery can visit a sign-in form, submit a successful POST, and freeze the form URL before the
app's delayed redirect happens. `observeOutcomes` observes completed mutation requests, but the
Driver contract does not expose pending navigation. The baseline is the entry page, so the form's
destination assertion is not baseline-vacuous. A surviving POST assertion proves the request, not
the redirect or authenticated destination.

Use the issue's advisory alternative: `observedBeforeLastMutation?: true` belongs only to the
`navigated` assertion variant. It records that the grounded destination already matched the URL
observed before the last executed step with a qualifying mutation in its request tail. Qualifying
means final observed status 200–399, a mutation method, non-benign traffic, and same-site under the
existing visited-page host/subdomain rule. A reverse scan preserves this boundary through trailing
scroll/wait/read steps. Stable request paths are not required; surviving request assertions do not
disarm the marker. Locale and declared wildcard options reach the same URL matcher as replay.

The CLI warns independently of action-proof strength. A consumer can reject this freeze or accept
the weaker statement that the page was reached. No new sleep, navigation signal, trace gate,
destination substitution, or replay failure condition is added. User/unknown-origin assertions
are never stamped. Existing baseline vacuity, step expects, and request assertions are retained.

## Verification

- Added two new test files without modifying any existing tests. Before production changes, the
  public `discover` regression failed because the expected marker was absent; its immediate
  redirect control passed. The CLI regression failed because the warning was absent, both with
  and without a surviving request proof. Helper cases initially failed on the missing helper.
- The final new coverage is 24 tests: request-proof coexistence, on-page save verdict preservation,
  post-mutation destination changes, trailing non-mutation steps, latest qualifying mutation,
  entry/pending/failed/benign/third-party exclusions, status/method/site qualification,
  user/unknown assertions, locale/wildcard policies and discovery wiring, and CLI warnings.
- `npm run typecheck` and `npm run build`: passed.
- `npm test`: **38 files, 876 tests passed**. The first sandboxed attempt passed 874 tests but
  failed two existing CLI subprocess tests because tsx could not open its local Unix socket
  (`EPERM`). Running the unchanged suite with local IPC available passed all 876.
- `git diff --check`: passed.
- Actual Chrome dogfood with a temporary Playwright-backed Driver, local HTTP fixture, and a
  scripted LLM reproduced `POST /api/auth/sign-in → 200`, then a 4-second delayed
  `location.assign('/dashboard')`. Before the fix, discovery froze an unmarked `/signin`; after
  the fix, it froze `/signin` with `observedBeforeLastMutation: true` while preserving the POST
  assertion and submit request expect. In both runs the browser subsequently reached `/dashboard`.
  This validates real browser evidence through an injected Driver; it does not validate the
  production Chrome MCP adapter's settle behavior. The portable committed regression command is
  `npm exec -w cairn-engine -- vitest run test/core/discover/navigation-evidence.test.ts test/cli-navigation-evidence.test.ts`.

## Limits

The marker is evidence provenance, not proof that a navigation is pending or caused by a mutation.
A legitimate on-page save can carry it. Request tails provide temporal attribution, so same-site
background traffic can qualify unless the consumer marks it benign. Very late traffic outside the
observed evidence remains invisible. The last *qualifying observed* mutation is the boundary;
pending, failed, and benign later traffic do not replace it. The current same-site rule does not
infer sibling API domains from a page hosted only on another subdomain. Those are existing seam
limits, not new navigation heuristics.

## State change

After merge, record #203's advisory freeze metadata and independent CLI warning as implemented;
the engine still does not promise settled navigation or change replay verdicts on this flag.
`spec/journal/state.md` is unchanged on this work branch.
