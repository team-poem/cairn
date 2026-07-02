import type { NetworkRequest } from "./types.js";

/** Requests whose failure is noise, not a regression — excluded from `no-failed-requests`. Built-in
 * universal noise (favicon, robots) plus any URL-substring a product marks benign. */
export function isBenignRequest(url: string, benign: readonly string[] = []): boolean {
  if (/\/favicon\.ico(\?|$)/i.test(url) || /\/robots\.txt(\?|$)/i.test(url)) return true;
  return benign.some((s) => url.includes(s));
}

// host + path with query/hash dropped — the endpoint identity for retry recovery. A retried
// request may vary only its query, but a different path (or method) is a different endpoint.
function endpointKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url.replace(/[?#].*$/, "").replace(/\/$/, "");
  }
}

/** A failed request is recovered noise when the SAME endpoint — method + host/path — later
 * answered under 400: the app retried and succeeded. Method must match so a successful
 * `GET /order` can never mask a failed `POST /order`. A failure with no later matching
 * success is still a real failure. Pure over the captured order (deterministic, invariant #4). */
export function isRecoveredFailure(requests: readonly NetworkRequest[], index: number): boolean {
  const failed = requests[index];
  if (!failed || failed.status < 400) return false;
  const method = failed.method.toUpperCase();
  const key = endpointKey(failed.url);
  return requests
    .slice(index + 1)
    .some((r) => r.status < 400 && r.method.toUpperCase() === method && endpointKey(r.url) === key);
}

/** Whether a request is a state-changing mutation (the kind that proves an action happened, vs a
 * navigation/read) — used to ground a scenario's success assertion on what did the work. */
export function isMutation(method: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}
