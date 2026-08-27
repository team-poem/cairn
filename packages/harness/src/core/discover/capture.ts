/**
 * Per-step outcome capture: derive the grounded post-condition (`expect`) a step is frozen with,
 * so a step that runs but doesn't reach its outcome is caught at replay (and healed). Expects are
 * decided RETROACTIVELY at freeze time from the completed evidence (#81) — never from a mid-run
 * snapshot that races the step's own in-flight request. See spec/core/surgical-heal.md.
 */
import type { Driver } from "../ports.js";
import type { Evidence, NetworkRequest, Step, WaitUntil } from "../types.js";
import { isBenignRequest, isMutation } from "../requests.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** host + path of a url (query/hash dropped) — a stable, meaningful destination to assert. */
export function destinationKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** What the loop records before each executed step: the page URL and the request-log length. The
 * log is append-only within a run (statuses update in place), so `[mark.requestCount, next mark)`
 * is exactly the tail of requests that step fired. */
export interface OutcomeMark {
  url: string | undefined;
  requestCount: number;
}

// The one bounded wait left (#81): only the FINAL evidence observation may still see the last
// step's mutation in flight (every earlier step's response resolved while later steps ran).
const OUTCOME_SETTLE_TIMEOUT_MS = 2_000;
const OUTCOME_SETTLE_POLL_MS = 200;

/** Observe the freeze-time evidence, waiting (bounded) while a mutation fired during the run is
 * still in flight — so retroactive expect/assertion grounding sees resolved statuses, not a race. */
export async function observeOutcomes(driver: Driver, firstRequestCount: number): Promise<Evidence> {
  const deadline = Date.now() + OUTCOME_SETTLE_TIMEOUT_MS;
  for (;;) {
    await driver.settle();
    const evidence = await driver.observe();
    const pending = evidence.logic.requests
      .slice(firstRequestCount)
      .some((r) => isMutation(r.method) && r.status === 0);
    if (!pending || Date.now() >= deadline) return evidence;
    await sleep(OUTCOME_SETTLE_POLL_MS);
  }
}

/** Retroactively attach each step's grounded post-condition from the completed evidence.
 * Navigation → expect that destination (the URL at the NEXT executed step, or the final URL —
 * nothing acts in between, so it is the page this step reached). Navigation is judged at
 * `destinationKey` granularity — the same granularity the expect is frozen at (#96): a query/hash-only
 * move would freeze a URL expect the PRE-navigation page already satisfies, so replay's idempotency
 * pre-check would silently skip the step; such a move falls through to the mutation expect (the fired
 * request is stronger evidence anyway). Else, a fresh successful mutation in the step's own request
 * tail → expect that request. A step that changed nothing stays unchecked — a weak expect would
 * trigger false divergence. `marks[i] === null` skips a step the loop doesn't verify (the baseUrl
 * goto). */
export function assignStepExpects(
  steps: Step[],
  marks: readonly (OutcomeMark | null)[],
  evidence: Evidence,
): void {
  const requests = evidence.logic.requests;
  for (let i = 0; i < steps.length; i++) {
    const mark = marks[i];
    if (!mark) continue;
    const next = marks.slice(i + 1).find((m): m is OutcomeMark => m !== null);
    const urlAfter = next ? next.url : evidence.execution.finalUrl;
    if (urlAfter && (!mark.url || destinationKey(urlAfter) !== destinationKey(mark.url))) {
      steps[i]!.expect = { url: destinationKey(urlAfter) };
      continue;
    }
    const tail = requests.slice(mark.requestCount, next?.requestCount ?? requests.length);
    const proven = freshMutationExpect(tail);
    if (proven) steps[i]!.expect = proven;
  }
}

/** A `requestStatus` post-condition for a mutation request the step itself fired and that succeeded —
 * the request that proves the action, so replay can wait for it. Benign noise is excluded, the method
 * is frozen for exact matching (a same-path GET must not satisfy a submit), and the frozen path stops
 * before a run-specific id segment (which would never match on a later replay). A repeated identical
 * mutation (a second add-to-cart) still counts — the tail is positional, not a seen-set. */
export function freshMutationExpect(tail: NetworkRequest[]): WaitUntil | undefined {
  const fresh = tail.find(
    (r) => isMutation(r.method) && r.status >= 200 && r.status < 400 && !isBenignRequest(r.url),
  );
  return fresh
    ? {
        requestStatus: {
          urlIncludes: stableEndpointPrefix(fresh.url),
          status: fresh.status,
          method: fresh.method.toUpperCase(),
        },
      }
    : undefined;
}

/** host + path cut at the first dynamic-looking segment (see `isDynamicSegment`) — a stable prefix
 * that still substring-matches the full request URL on a later replay, where a run-specific id
 * would never match again. Query and hash are dropped with the rest of the URL by `destinationKey`.
 * Shared with assertion grounding (#172) so a step expect and a `request-status` assertion freeze
 * the same endpoint identity. */
export function stableEndpointPrefix(url: string): string {
  const [host = "", ...segs] = destinationKey(url).split("/");
  const stable: string[] = [];
  for (const seg of segs) {
    if (isDynamicSegment(seg)) break;
    stable.push(seg);
  }
  return [host, ...stable].join("/");
}

/**
 * Does this path segment look like a value the run minted, rather than a route the developer named?
 * The cut decides what a frozen check matches, so both errors are real: cutting a route name
 * (`checkout-v2` → the check then matches every sibling endpoint) is a false GREEN, and keeping a
 * run-specific id is the permanent false FAIL of #172. The rule therefore recognizes *id shapes*
 * and treats a hyphen, dot or percent-escape as the mark of a human-authored name:
 *
 *   cut  — 586738 · a uuid · deadbeefcafebabe (bare hex) · ord_8f3a2c · s3kr3t99 · orders;id=586738
 *   keep — checkout-v2 · b2b-orders · oauth2-callback · 2026-08-27 · app.3fa4b1c2.js · %E7%A2%BA
 *
 * Known gaps (kept deliberately — an under-cut fails loudly, an over-cut passes silently):
 * a short id (`a3f9`), a digit-free token (`ord_abcdef`, a base64 slug). See STABLE_PREFIX_CORPUS.
 */
function isDynamicSegment(seg: string): boolean {
  if (/^\d+$/.test(seg)) return true; // 586738, a timestamp
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true; // uuid
  if (/^[0-9a-f]{8,}$/i.test(seg)) return true; // bare hex digest
  // A long token carrying digits, with none of the separators a named route uses.
  return seg.length >= 8 && /\d/.test(seg) && !/[-.%]/.test(seg);
}
