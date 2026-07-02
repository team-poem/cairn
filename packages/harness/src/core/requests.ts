import type { NetworkRequest } from "./types.js";

/** The one request-status predicate: the first captured request matching BOTH url and status.
 * Shared by the deterministic critic (`request-status`) and `conditionMet` (waitFor / step
 * `expect`) so a verdict can never depend on which matching request arrived first — an endpoint
 * that answered 401 and then 200 on retry satisfies `status: 200`. */
export function findRequestStatus(
  requests: readonly NetworkRequest[],
  urlIncludes: string,
  status: number,
): NetworkRequest | undefined {
  return requests.find((r) => r.url.includes(urlIncludes) && r.status === status);
}

/** Requests whose failure is noise, not a regression — excluded from `no-failed-requests`. Built-in
 * universal noise (favicon, robots) plus any URL-substring a product marks benign. */
export function isBenignRequest(url: string, benign: readonly string[] = []): boolean {
  if (/\/favicon\.ico(\?|$)/i.test(url) || /\/robots\.txt(\?|$)/i.test(url)) return true;
  return benign.some((s) => url.includes(s));
}

/** Whether a request is a state-changing mutation (the kind that proves an action happened, vs a
 * navigation/read) — used to ground a scenario's success assertion on what did the work. */
export function isMutation(method: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}
