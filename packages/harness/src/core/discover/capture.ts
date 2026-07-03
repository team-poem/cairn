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
 * nothing acts in between, so it is the page this step reached). Else, a fresh successful mutation
 * in the step's own request tail → expect that request. A step that changed nothing stays
 * unchecked — a weak expect would trigger false divergence. `marks[i] === null` skips a step the
 * loop doesn't verify (the baseUrl goto). */
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
    if (urlAfter && urlAfter !== mark.url) {
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

/** host + path cut at the first dynamic-looking segment (all digits, or ≥8 chars containing one —
 * ids, uuids, timestamps) — a stable prefix that still substring-matches the full request URL on a
 * later replay, where a run-specific id would never match again. */
function stableEndpointPrefix(url: string): string {
  const [host = "", ...segs] = destinationKey(url).split("/");
  const stable: string[] = [];
  for (const seg of segs) {
    if (/^\d+$/.test(seg) || (seg.length >= 8 && /\d/.test(seg))) break;
    stable.push(seg);
  }
  return [host, ...stable].join("/");
}
