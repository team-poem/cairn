/**
 * Per-step outcome capture: derive the grounded post-condition (`expect`) a step is frozen with,
 * so a step that runs but doesn't reach its outcome is caught at replay (and healed). Expects are
 * decided RETROACTIVELY at freeze time from the completed evidence (#81) — never from a mid-run
 * snapshot that races the step's own in-flight request. See spec/core/surgical-heal.md.
 */
import type { Driver } from "../ports.js";
import type { Evidence, NetworkRequest, Step, WaitUntil } from "../types.js";
import { isBenignRequest, isMutation } from "../requests.js";
import { urlReached, WILDCARD } from "../steps.js";
import type { UrlMatchOptions } from "../steps.js";

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
  /** The consumer's matching rules — replay pre-checks a frozen URL expect with these, so the
   * freeze has to ask "is this already satisfied?" under the same ones. Locale stripping only ever
   * makes matching MORE permissive, so freezing under the defaults while replay runs with an
   * injected prefix flips a discriminating expect into a pre-satisfied one, and the step is skipped. */
  opts: UrlMatchOptions & { benign?: readonly string[] } = {},
): void {
  const { benign = [], ...urlMatch } = opts;
  const requests = evidence.logic.requests;
  for (let i = 0; i < steps.length; i++) {
    const mark = marks[i];
    if (!mark) continue;
    const next = marks.slice(i + 1).find((m): m is OutcomeMark => m !== null);
    const urlAfter = next ? next.url : evidence.execution.finalUrl;
    // Judge on the value ABOUT TO BE FROZEN, not on the concrete urls: replay pre-checks a URL
    // expect before running the step and skips it when already satisfied, so an expect the
    // pre-navigation page also satisfies makes the step vanish (#96's failure class). Generalizing
    // the frozen value re-opened that door — two siblings of one template (`/orders/111` →
    // `/orders/222`) both match `shop.co/orders/*`. Such a step keeps no URL expect and falls
    // through to its mutation expect, or stays unchecked.
    const frozenUrl = urlAfter ? stableDestination(urlAfter) : undefined;
    if (frozenUrl && namesAPage(frozenUrl) && (!mark.url || !urlReached(mark.url, frozenUrl, urlMatch))) {
      steps[i]!.expect = { url: frozenUrl };
      continue;
    }
    const tail = requests.slice(mark.requestCount, next?.requestCount ?? requests.length);
    const proven = freshMutationExpect(tail, benign);
    if (proven) steps[i]!.expect = proven;
  }
}

/** A `requestStatus` post-condition for a mutation request the step itself fired and that succeeded —
 * the request that proves the action, so replay can wait for it. Benign noise is excluded, the method
 * is frozen for exact matching (a same-path GET must not satisfy a submit), and the frozen path stops
 * before a run-specific id segment (which would never match on a later replay). A repeated identical
 * mutation (a second add-to-cart) still counts — the tail is positional, not a seen-set. */
export function freshMutationExpect(tail: NetworkRequest[], benign: readonly string[] = []): WaitUntil | undefined {
  // A host-only endpoint is skipped rather than frozen — it would be satisfied by any request to
  // that host (the same refusal the assertion path makes, #172) — but the search continues past it:
  // a pixel or RPC fired at the root must not cost the step the real mutation behind it.
  const fresh = tail.find(
    (r) =>
      isMutation(r.method) &&
      r.status >= 200 &&
      r.status < 400 &&
      !isBenignRequest(r.url, benign) &&
      hasStablePath(stableEndpointPrefix(r.url)),
  );
  if (!fresh) return undefined;
  return {
    requestStatus: {
      urlIncludes: stableEndpointPrefix(fresh.url),
      status: fresh.status,
      method: fresh.method.toUpperCase(),
    },
  };
}

/** host + path cut at the first dynamic-looking segment (see `isDynamicSegment`) — a stable prefix
 * that a later replay still matches, where a run-specific id would never match again. The path
 * portion is matched by substring; a query-dispatch endpoint may keep a leading run of its query
 * (`stableQuerySuffix`), matched as parsed key/value pairs instead (`urlMatchesFrozen`, #200) —
 * see `groundingMatch`/matcher call sites, not a literal substring of the whole value. Hash is
 * dropped with the rest of the URL by `destinationKey`. Shared with assertion grounding (#172) so
 * a step expect and a `request-status` assertion freeze the same endpoint identity. */
export function stableEndpointPrefix(url: string): string {
  const [host = "", ...segs] = destinationKey(url).split("/");
  const stable: string[] = [];
  for (const seg of segs) {
    if (isDynamicSegment(seg)) break;
    stable.push(seg);
  }
  const path = [host, ...stable].join("/");
  // A cut path is a prefix of the URL, so nothing that follows the cut can be appended to it.
  if (stable.length < segs.length) return path;
  const withQuery = path + stableQuerySuffix(url);
  // Only the PATH portion is matched by substring — the query is compared as parsed key/value
  // pairs by `urlMatchesFrozen`, not as literal text — so only the path has to actually occur in
  // the URL. Checking the whole `path + query` string here (#200) failed on a trailing slash before
  // the query (`shop.co/rpc/?action=…` vs the frozen `shop.co/rpc?action=…`) and silently dropped
  // the query, which is exactly the discriminator a query-dispatch endpoint needs.
  return url.includes(path) ? withQuery : path;
}

/**
 * The leading run of query params whose values the run did not mint — the discriminator for an API
 * that dispatches on the query rather than the path (`/graphql?op=AddToCart`, `?action=checkout`),
 * where the path alone names no action and any other POST to the endpoint would satisfy the check.
 * Stops at the first run-specific value (`?buyRequestIds=586738`), which is what #172 must drop.
 *
 * Leading run, not a filter: the frozen value used to be matched by substring, so the kept params
 * had to be contiguous from the start of the query — everything from the first run-specific value
 * on is dropped with it, since a frozen value cannot skip a param it does not know. The query is
 * now matched as parsed key/value pairs instead (`urlMatchesFrozen`, #200), which would tolerate a
 * gap — but this function still stops at the first run-specific value; turning it into a filter
 * that keeps every stable param is a separate change.
 */
function stableQuerySuffix(url: string): string {
  const query = url.match(/\?([^#]*)/)?.[1];
  if (!query) return "";
  const kept: string[] = [];
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    const value = eq === -1 ? "" : pair.slice(eq + 1);
    if (!value || isDynamicSegment(value)) break;
    kept.push(pair);
  }
  return kept.length ? `?${kept.join("&")}` : "";
}

/**
 * Does this path segment look like a value the run minted, rather than a route the developer named?
 * The cut decides what a frozen check matches, so both errors are real: cutting a route name
 * (`checkout-v2` → the check then matches every sibling endpoint) is a false GREEN, and keeping a
 * run-specific id is the permanent false FAIL of #172.
 *
 *   cut  — 586738 · a uuid · deadbeefcafebabe · ord_8f3a2c · order-<uuid> (its first block is a
 *          digest — the uuid rule only reads a whole segment) · 2026-08-27 · orders;id=586738
 *   keep — checkout-v2 · checkout_v2 · b2b-orders · oauth2-callback · oauth2callback · checkoutV2 ·
 *          base64decode · %E7%A2%BA (a percent-escaped name)
 *
 * Generated ids that carry capitals are recognized by shape (ULID, JWT) or by digit density — see
 * `isDigitDenseToken`. Known gaps that remain: a short id (`a3f9`), a digit-free token
 * (`ord_abcdef`, a bare base62 slug), and any id whose digits are too sparse to tell it apart from
 * a name. #172 still bites there, and not cheaply — a frozen check that can never match re-runs
 * outcome-heal on every execution — but widening further would swallow real route names, which
 * fails the other way (a check that passes on the wrong request). See STABLE_PREFIX_CORPUS.
 */
function isDynamicSegment(seg: string): boolean {
  if (/^\d+$/.test(seg)) return true; // 586738, a timestamp
  if (isUuid(seg)) return true;
  if (isUlid(seg) || isJwt(seg)) return true;
  if (/^[0-9a-f]{8,}$/i.test(seg)) return true; // bare hex digest
  if (isIsoDate(seg)) return true; // a date is a resource key, not a route name
  // A named route separates its words (`checkout-v2`, `oauth2_callback`, a percent-escaped name);
  // an id survives that separation (`order-<uuid>`, `sess-a1b2c3d4`, `orders;id=586738`).
  if (SEGMENT_SEPARATORS.test(seg)) return seg.split(SEGMENT_SEPARATORS).some(isIdPart);
  // Unseparated: a route word carries its digits in one run (`base64decode`, `oauth2callback`)
  // where a token scatters them (`s3kr3t99`) — and a capitalized token is read by density, the
  // same test its separated form gets. Without this second half the density rule would only ever
  // see a segment that happens to contain a separator, which is a coin flip for a nanoid.
  if (isDigitDenseToken(seg)) return true;
  return seg.length >= 8 && !/[A-Z]/.test(seg) && (seg.match(/\d+/g)?.length ?? 0) >= 2;
}

/** The characters a named route uses between its words — and that an id keeps its shape across. */
const SEGMENT_SEPARATORS = /[-._%;=~]/;

/**
 * An id-shaped piece of a separated segment. Two calibrations, both from counter-examples:
 * digits are required of the hex form, so a plain word that spells hex (`decade`, `facade`) is not
 * read as a digest; and a numeric piece must be long enough to be a key, because a short number
 * inside a named route is a qualifier or a fixed identifier, not a run-minted id — `step-2`,
 * `top-100`, `tier-1`, `covid-19`, `error-404`, `sale-2024`, `CVE-2024-21413`. Cutting them made a
 * 2nd-step check pass on the 1st step (and on `/checkout/abandon`). Six digits is the floor, so an
 * id with shorter groups survives; see the corpus.
 */
function isIdPart(part: string): boolean {
  if (/^\d{6,}$/.test(part)) return true;
  if (part.length >= 6 && /^[0-9a-f]+$/i.test(part) && /\d/.test(part)) return true;
  return isDigitDenseToken(part);
}

/**
 * A token whose capitals, digit density AND digit scatter mark it as generated rather than written.
 * Density alone: a fifth of the characters or more are digits — `a1B2c3D4e5F6g7H8` (a key's tail) is
 * 50% and a whole nanoid 24%, while `checkoutV2Submit` is 6% and `getS3BucketUrl2` 13%. Scatter is the second half, and it is what keeps a standard's name out: `SHA256Digest`,
 * `Ed25519Sign`, `ISO8601Date` and `X25519Key` all clear the density bar but carry their digits in
 * ONE run, where a generated token spreads them across several.
 *
 * All-lowercase tokens are left to the digit-run rule; they are the most name-like, and pulling
 * them in here would swallow `sha256sum` and its kind.
 */
function isDigitDenseToken(part: string): boolean {
  if (part.length < 8 || !/^[A-Za-z0-9]+$/.test(part)) return false;
  const runs = part.match(/\d+/g) ?? [];
  const digits = runs.join("").length;
  // Scattered digits behind capitals: a generated token. A fifth of the characters is the floor —
  // a whole nanoid sits at 24%.
  if (runs.length >= 3 && /[A-Z]/.test(part) && digits * 5 >= part.length) return true;
  // One run instead, but the token is mostly number: a human-readable key with a letter prefix —
  // ORD12345678, INV20260827, TXN0001234567 — which no amount of scatter would catch. The floor is
  // three fifths precisely so a standard's name stays out: X25519Key is 56%, Ed25519Sign 45%.
  return digits * 5 >= part.length * 3;
}

/** Crockford base32, 26 characters, no I/L/O/U — the ULID alphabet exactly. */
function isUlid(s: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);
}

/**
 * Three base64url parts: header.payload.signature. Each real part encodes JSON (or a signature), so
 * it always mixes case or carries digits — required here, because the base64url alphabet alone also
 * describes a dotted config slug (`production-cluster.service-registry.canary-rollout`), which is a
 * name, not an id.
 */
function isJwt(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 3) return false;
  return parts.every(
    (p) => /^[A-Za-z0-9_-]{10,}$/.test(p) && (/\d/.test(p) || (/[a-z]/.test(p) && /[A-Z]/.test(p))),
  );
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * A full ISO date, `YYYY-MM-DD`, this century only. The ranges keep a numeric part code (`1234-56`,
 * a SKU `1000-01`) from reading as a date, and the day is REQUIRED because `YYYY-MM` alone is a
 * name at least as often as it is a value: `/admin/api/2024-01/orders` is a pinned API version and
 * `/blog/2024-03/index` a monthly archive. Cutting those is a false GREEN (every endpoint under
 * that version satisfies the check), while keeping a monthly report path is a loud failure — the
 * cheaper error. Other written forms (`08-27-2026`, `2026.08.27`, `2026-W35`, a timestamp) are not
 * recognized either; see the corpus.
 */
function isIsoDate(seg: string): boolean {
  return /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(seg);
}

/**
 * Do two request URLs name the same endpoint — same shape, differing only where the run mints
 * values? `/cart/add?ids=586738` and `/cart/add?ids=586739` do (one action, fired twice);
 * `/api/products` and `/api/products/586738` do not, nor do `/orders/1/confirm` and
 * `/orders/2/cancel`. Used to tell a widening that keeps the check's meaning from one that spends it.
 */
export function sameEndpointShape(a: string, b: string): boolean {
  const segsA = destinationKey(a).split("/");
  const segsB = destinationKey(b).split("/");
  if (segsA.length !== segsB.length) return false;
  return segsA.every((seg, i) => seg === segsB[i] || (isDynamicSegment(seg) && isDynamicSegment(segsB[i]!)));
}

/**
 * The destination to freeze for a `navigated` check (and a step's URL expect): host + path with
 * every run-minted segment replaced by `*`, which `urlReached` matches one-for-one. A URL with no
 * such segment freezes exactly as before.
 *
 * Why not the stable PREFIX used for request URLs: a request check matches by substring, so cutting
 * at the first id still matches the whole URL, but a destination is matched at a path boundary and
 * a parent never counts as reaching a deeper page — `shop.co/orders` would fail even against the
 * run that discovered `shop.co/orders/586738/done`. The wildcard keeps the depth and the segments
 * around the id, and pins the host either way.
 */
export function stableDestination(url: string): string {
  const [host = "", ...segs] = destinationKey(url).split("/");
  return [host, ...segs.map((seg) => (isDynamicSegment(seg) ? WILDCARD : seg))].join("/");
}

/**
 * Does a frozen destination name a page, or merely the area one lives in? `shop.co/*` is reached by
 * an error page and a login redirect alike, which is exactly what `navigated` exists to catch — and
 * `shop.co/app/*` is no better in an app that mounts login and errors under the same prefix. The
 * cost of this line is real: a list → detail step freezes no URL check, since `/products/586738`
 * generalizes to a wildcard leaf. Losing a check is the loud direction; keeping one that the error
 * page satisfies is the silent one.
 *
 * Caveat: a literal `*` is legal in a URL path and is not escaped here, so a page whose real path
 * contains one freezes as a wildcard and matches more than it did before.
 */
export function namesAPage(destination: string): boolean {
  const path = destination.split("/").slice(1).filter((seg) => seg !== "");
  // The LAST segment has to be literal, not merely some segment: `/app/*` and `/products/*` keep a
  // literal mount prefix and are still reached by that app's own `/app/login` and `/app/error`,
  // because the leaf is where the page's identity lives. `/orders/*/done` keeps it.
  return path.length > 0 && path[path.length - 1] !== WILDCARD;
}

/** Did any path survive the cut? A host-only prefix would be satisfied by every request to that
 * host, so it is refused rather than frozen — by the assertion path and the step expect alike.
 * Checked on the PATH half only (cut at the first `?`, #200) — a kept query value can itself
 * contain a `/` (a `?next=/dashboard` redirect param), which is not a path and must not count. */
export function hasStablePath(prefix: string): boolean {
  const path = prefix.split("?")[0] ?? prefix;
  return path.includes("/");
}
