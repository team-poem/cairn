/**
 * Per-step outcome capture: derive the grounded post-condition (`expect`) a step is frozen with,
 * so a step that runs but doesn't reach its outcome is caught at replay (and healed). See
 * spec/core/surgical-heal.md.
 */
import type { Driver } from "../ports.js";
import type { NetworkRequest, WaitUntil } from "../types.js";
import { isBenignRequest, isMutation } from "../requests.js";

/** host + path of a url (query/hash dropped) — a stable, meaningful destination to assert. */
export function destinationKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** A grounded post-condition for a step, so a step that runs but doesn't reach its outcome is caught
 * (and, at replay, waited-for then healed). Navigation → expect that destination. Else, if the step
 * fired a fresh successful mutation (POST/PUT/PATCH/DELETE — a submit/create), expect that request:
 * this covers async actions (a login submit) the URL-only check missed. A step that changes nothing
 * stays unchecked — a weak expect would trigger false divergence. */
export async function stepExpect(
  driver: Driver,
  before: { url: string | undefined; requests: NetworkRequest[] },
): Promise<WaitUntil | undefined> {
  await driver.settle();
  const after = await driver.observe();
  const afterUrl = after.execution.finalUrl;
  if (afterUrl && afterUrl !== before.url) return { url: destinationKey(afterUrl) };
  return freshMutationExpect(after.logic.requests.slice(before.requests.length));
}

/** A `requestStatus` post-condition for a mutation request the step itself fired and that succeeded —
 * the request that proves the action, so replay can wait for it. Benign noise is excluded, the method
 * is frozen for exact matching (a same-path GET must not satisfy a submit), and the frozen path stops
 * before a run-specific id segment (which would never match on a later replay). The request log is
 * append-only within a run, so the step's own requests are exactly the tail past the pre-step count —
 * a repeated identical mutation (a second add-to-cart) still counts as fresh. */
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
