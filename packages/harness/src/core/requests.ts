import type { NetworkRequest } from "./types.js";

/** Raw key -> raw value pairs of a query string ("a=1&b=2"), last one wins on a duplicate key.
 * No decoding — matched as literal text, same as the containment match this replaces. */
function parseQueryPairs(query: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    pairs.set(key, eq === -1 ? "" : pair.slice(eq + 1));
  }
  return pairs;
}

/** Does `url` satisfy a frozen `urlIncludes`? The part before the first `?` is a plain substring
 * match, exactly as `urlIncludes` has always worked. The part after `?`, if any, is compared as a
 * SUBSET of the URL's own query: every frozen key=value pair must be present with an equal value —
 * extra params on the URL are tolerated, order doesn't matter. Plain substring on the whole query
 * let a longer operation name satisfy a shorter frozen one (`?op=AddToCart` matched by a replay
 * firing `?op=AddToCartV2`, ordinary GraphQL versioning) and made the match order-sensitive
 * (`?op=AddToCart` failing against `?trace=xy&op=AddToCart`). #200. Shared by every request-status
 * call site (this predicate, discovery-time grounding, the assertion diagnostic) so a verdict and
 * its diagnostic can never disagree. */
export function urlMatchesFrozen(url: string, urlIncludes: string): boolean {
  const q = urlIncludes.indexOf("?");
  if (q === -1) return url.includes(urlIncludes);
  const path = urlIncludes.slice(0, q);
  if (!url.includes(path)) return false;
  const actual = parseQueryPairs(url.match(/\?([^#]*)/)?.[1] ?? "");
  for (const [key, value] of parseQueryPairs(urlIncludes.slice(q + 1))) {
    if (actual.get(key) !== value) return false;
  }
  return true;
}

/** The one request-status predicate: the first captured request matching url AND status (AND
 * method, when given — so a same-prefix GET can't satisfy a POST check on a status collision).
 * Shared by the deterministic critic (`request-status`) and `conditionMet` (waitFor / step
 * `expect`) so a verdict can never depend on which matching request arrived first — an endpoint
 * that answered 401 and then 200 on retry satisfies `status: 200`. */
export function findRequestStatus(
  requests: readonly NetworkRequest[],
  urlIncludes: string,
  status: number,
  method?: string,
): NetworkRequest | undefined {
  const m = method?.toUpperCase();
  return requests.find(
    (r) => urlMatchesFrozen(r.url, urlIncludes) && r.status === status && (!m || r.method.toUpperCase() === m),
  );
}

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
  // status 0 = still in flight, not a recovery — only a resolved success counts.
  return requests
    .slice(index + 1)
    .some((r) => r.status > 0 && r.status < 400 && r.method.toUpperCase() === method && endpointKey(r.url) === key);
}

/** Is `url` on the site of a page the flow was on — the page's host or a subdomain of it, so with
 * the page at `shop.co` both `api.shop.co` and `sockjs.shop.co` are the app's own and
 * `api2.amplitude.com` is not? The line between an app's traffic and third-party background posts
 * (analytics, error reporters), which fire on their own schedule and never prove the app's action.
 * A leading `www.` on the page is not a site boundary. No public-suffix list is needed: `shop.co.kr`
 * and `other.co.kr` are different sites because neither is under the other. The miss is a page on
 * `app.shop.co` claiming nothing on `api.shop.co` — the quiet direction; callers pass every page the
 * flow visited to narrow it. Unparseable URLs never match. */
export function onSiteOf(pageUrl: string, url: string): boolean {
  const host = (u: string): string | undefined => {
    try {
      return new URL(u).hostname;
    } catch {
      return undefined;
    }
  };
  const page = host(pageUrl)?.replace(/^www\./, "");
  const h = host(url);
  return page !== undefined && h !== undefined && (h === page || h.endsWith("." + page));
}

/** Whether a request is a state-changing mutation (the kind that proves an action happened, vs a
 * navigation/read) — used to ground a scenario's success assertion on what did the work. */
export function isMutation(method: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}
