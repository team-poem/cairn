/**
 * URL-matching counter-example corpus — the regression table for the expect-URL zone
 * (`destinationKey` / `urlReached` / locale handling / `assignStepExpects`).
 *
 * This zone has produced a chain of regressions (#56 → #86/#87, #81 → #96) because fixes were
 * validated only against the app being dogfooded at the time. Any change to URL matching must
 * pass this WHOLE table, not just the case that motivated it. Add counter-examples here first;
 * never narrow a case to make a fix pass.
 */

/** A pair of page URLs around one step: did the step change the *destination* (host+path),
 * i.e. may freeze assign a URL expect for it (#96)? Query/hash-only moves must not — the
 * pre-navigation page already satisfies such an expect, so replay's idempotency pre-check
 * would silently skip the step. */
export interface DestinationChangeCase {
  note: string;
  before: string;
  after: string;
  changed: boolean;
}

/** Did `final` reach the frozen destination `want` (#86/#87)? Run with DEFAULT options — the
 * engine's out-of-the-box judgment. Locale-stripping is a fallback over a small consumer-overridable
 * prefix list; it must never swallow a real route that merely looks like a locale ("/my", "/go"). */
export interface UrlReachedCase {
  note: string;
  final: string;
  want: string;
  reached: boolean;
}

export const URL_REACHED_CORPUS: UrlReachedCase[] = [
  // exact / normalization
  { note: "exact host+path; scheme, query, hash ignored", final: "https://x.co/en/cart?a=1#h", want: "x.co/en/cart", reached: true },
  { note: "trailing slash on final", final: "https://x.co/en/", want: "x.co/en", reached: true },
  { note: "trailing slash on want", final: "https://x.co/en", want: "x.co/en/", reached: true },
  { note: "query-only difference", final: "https://x.co/list?page=2", want: "x.co/list", reached: true },
  { note: "hash-only difference", final: "https://x.co/app#/cart", want: "x.co/app", reached: true },
  // boundaries (parent ≠ child)
  { note: "bare suffix at a path boundary", final: "https://x.co/en/cart", want: "cart", reached: true },
  { note: "leading-slash want", final: "https://x.co/en/cart", want: "/en/cart", reached: true },
  { note: "suffix NOT at a boundary", final: "https://x.co/encart", want: "cart", reached: false },
  { note: "deeper final does not reach its parent", final: "https://x.co/en/signin", want: "x.co/en", reached: false },
  { note: "parent final does not reach a child", final: "https://x.co/en", want: "x.co/en/signin", reached: false },
  { note: "different host, same path", final: "https://evil.co/cart", want: "x.co/cart", reached: false },
  // locale fallback (default prefix list)
  { note: "cross-locale ko→en", final: "https://x.co/ko/cart", want: "x.co/en/cart", reached: true },
  { note: "cross-locale jp→en", final: "https://x.co/jp/payment", want: "x.co/en/payment", reached: true },
  { note: "locale present only on final", final: "https://x.co/en/cart", want: "x.co/cart", reached: true },
  { note: "locale present only on want", final: "https://x.co/cart", want: "x.co/en/cart", reached: true },
  { note: "region variant matches its base language", final: "https://x.co/en-US/cart", want: "x.co/en/cart", reached: true },
  { note: "cross-locale but different path", final: "https://x.co/ko/signin", want: "x.co/en/cart", reached: false },
  { note: "non-default locale (fr) is NOT stripped — consumers inject it", final: "https://x.co/fr/cart", want: "x.co/en/cart", reached: false },
  // real two-letter routes (the #86 bug: traits must not be promoted to facts)
  { note: "real route /my is not swallowed as a locale (#86)", final: "https://x.co/", want: "x.co/my", reached: false },
  { note: "real route /my matches itself", final: "https://x.co/my", want: "x.co/my", reached: true },
  { note: "real route /my does not reach a child", final: "https://x.co/my", want: "x.co/my/settings", reached: false },
  { note: "two different real two-letter routes never match", final: "https://x.co/go", want: "x.co/tv", reached: false },
  // scheme present/absent (#87): frozen values are scheme-less host+path; `new URL()` silently
  // mis-parses "localhost:3000/mentor" (scheme "localhost:", empty host) — parsing must not depend
  // on the frozen side carrying a scheme.
  { note: "scheme-less want with a port (#87)", final: "http://localhost:3000/mentor", want: "localhost:3000/mentor", reached: true },
  { note: "scheme-less want with a port, host root (#87)", final: "http://localhost:3000/", want: "localhost:3000", reached: true },
  { note: "scheme-less final AND want with a port (#87)", final: "localhost:3000/mentor", want: "localhost:3000/mentor", reached: true },
  { note: "scheme-present want", final: "https://x.co/cart", want: "https://x.co/cart", reached: true },
  { note: "scheme on want only", final: "x.co/cart", want: "https://x.co/cart", reached: true },
  { note: "port + parent≠child boundary (#87)", final: "http://localhost:3000/mentor/apply", want: "localhost:3000/mentor", reached: false },
  { note: "port + different route (#87)", final: "http://localhost:3000/mentor", want: "localhost:3000/admin", reached: false },
];

export const DESTINATION_CHANGE_CORPUS: DestinationChangeCase[] = [
  { note: "query-only change (pagination)", before: "https://app/list?page=1", after: "https://app/list?page=2", changed: false },
  { note: "query added", before: "https://app/list", after: "https://app/list?page=1", changed: false },
  { note: "hash-only change (SPA hash route)", before: "https://app/app", after: "https://app/app#/cart", changed: false },
  { note: "hash removed", before: "https://app/app#/cart", after: "https://app/app", changed: false },
  { note: "trailing slash only", before: "https://app/list", after: "https://app/list/", changed: false },
  { note: "child path (parent≠child boundary)", before: "https://app/en", after: "https://app/en/signin", changed: true },
  { note: "sibling path", before: "https://app/form", after: "https://app/done", changed: true },
  { note: "host change, same path", before: "https://a.co/x", after: "https://b.co/x", changed: true },
  { note: "path change with query noise on both sides", before: "https://app/list?page=2", after: "https://app/detail?from=list", changed: true },
];

/** What a captured request URL freezes to in a `request-status` assertion / step expect
 * (`stableEndpointPrefix`): host + path cut before the first dynamic-looking segment, with
 * query and hash gone. `frozen: null` = nothing but the host survives, so the check is dropped
 * instead of frozen — a host-only substring matches every request to that host (false GREEN). */
export interface StablePrefixCase {
  note: string;
  url: string;
  frozen: string | null;
}

export const STABLE_PREFIX_CORPUS: StablePrefixCase[] = [
  // the #172 shape: a per-run id the model pinned to tell two firings of one POST apart
  { note: "run-specific id in the query is dropped (#172)", url: "https://shop.co/cart/add-carts?buyRequestIds=586738", frozen: "shop.co/cart/add-carts" },
  { note: "multi-value query dropped whole", url: "https://shop.co/cart/add-carts?buyRequestIds=586738,586739&from=list", frozen: "shop.co/cart/add-carts" },
  { note: "hash dropped", url: "https://shop.co/api/order#done", frozen: "shop.co/api/order" },
  { note: "trailing slash dropped", url: "https://shop.co/api/cart/", frozen: "shop.co/api/cart" },
  // id-shaped path segments cut the path
  { note: "numeric id segment", url: "https://shop.co/api/orders/586738/confirm", frozen: "shop.co/api/orders" },
  { note: "uuid segment", url: "https://shop.co/api/carts/9f8b7c6d-1234-4a5b-8c9d-000111222333/items", frozen: "shop.co/api/carts" },
  { note: "prefixed uuid segment", url: "https://shop.co/api/carts/cart-9f8b7c6d-1234-4a5b-8c9d-000111222333/items", frozen: "shop.co/api/carts" },
  { note: "timestamp segment", url: "https://shop.co/api/events/20260827120000/ack", frozen: "shop.co/api/events" },
  { note: "fractional timestamp segment", url: "https://shop.co/api/t/1756276800.123/ack", frozen: "shop.co/api/t" },
  { note: "bare hex digest segment", url: "https://shop.co/x/deadbeefcafebabe/confirm", frozen: "shop.co/x" },
  { note: "prefixed id — caught because THIS sample is pure hex; a base62 tail is a KNOWN GAP below", url: "https://shop.co/orders/ord_8f3a2c/confirm", frozen: "shop.co/orders" },
  { note: "session slug — same: hex-alphabet sample, not session slugs in general", url: "https://shop.co/s/sess-a1b2c3d4/resume", frozen: "shop.co/s" },
  { note: "opaque token, digits scattered", url: "https://shop.co/api/s3kr3t99/items", frozen: "shop.co/api" },
  { note: "matrix param carrying an id", url: "https://shop.co/api/orders;id=586738/confirm", frozen: "shop.co/api" },
  { note: "percent-encoded id — caught only because %3A + a 6-digit id spells an 8-char hex piece", url: "https://shop.co/api/q/%7B%22id%22%3A586738%7D/run", frozen: "shop.co/api/q" },
  { note: "a full ISO date in a path is a resource key (this century, YYYY-MM-DD only)", url: "https://shop.co/api/reports/2026-08-27/export", frozen: "shop.co/api/reports" },
  { note: "year-month is NOT cut — an API version pins one (`/admin/api/2024-01/...`)", url: "https://shop.co/admin/api/2024-01/orders", frozen: "shop.co/admin/api/2024-01/orders" },
  { note: "…and a monthly archive is a name too", url: "https://shop.co/blog/2024-03/index", frozen: "shop.co/blog/2024-03/index" },
  { note: "a fixed public identifier is not a run-minted id", url: "https://shop.co/advisories/CVE-2024-21413/details", frozen: "shop.co/advisories/CVE-2024-21413/details" },
  { note: "hashed asset filename", url: "https://shop.co/files/app.3fa4b1c2.js", frozen: "shop.co/files" },
  // Generated ids that carry capitals: by exact shape (ULID, JWT) or by digit density.
  { note: "ULID", url: "https://shop.co/o/01ARZ3NDEKTSV4RRFFQ69G5FAV/confirm", frozen: "shop.co/o" },
  { note: "nanoid with no separator in it — about half of them", url: "https://shop.co/o/V1StGXR8Z5jdHi6BmyT9k/confirm", frozen: "shop.co/o" },
  { note: "a key tail standing alone, not only behind a prefix", url: "https://shop.co/o/a1B2c3D4e5F6g7H8/confirm", frozen: "shop.co/o" },
  // Human-readable keys: a letter prefix on a number block. Scatter never catches these, so the
  // density floor alone decides them — set high enough (three fifths) to clear every standard name.
  { note: "order key", url: "https://shop.co/o/ORD12345678/confirm", frozen: "shop.co/o" },
  { note: "invoice key", url: "https://shop.co/o/INV20260827/confirm", frozen: "shop.co/o" },
  { note: "transaction key with padding", url: "https://shop.co/o/TXN0001234567/confirm", frozen: "shop.co/o" },
  { note: "lowercase order key", url: "https://shop.co/o/ord12345678/confirm", frozen: "shop.co/o" },
  { note: "lowercase ULID — cut by the digit-run rule, NOT by the ULID shape", url: "https://shop.co/o/01arz3ndektsv4rrffq69g5fav/confirm", frozen: "shop.co/o" },
  { note: "prefixed key with a random tail (Stripe shape)", url: "https://shop.co/o/cs_test_a1B2c3D4e5F6g7H8/confirm", frozen: "shop.co/o" },
  { note: "a real JWT — three base64url parts", url: "https://shop.co/verify/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c/confirm", frozen: "shop.co/verify" },
  // NAMED ROUTES THAT ONLY LOOK DYNAMIC — cutting one makes the frozen check match every sibling
  // endpoint under the surviving prefix (a false GREEN, the worse error). All of these must survive.
  { note: "hyphenated route with a version suffix", url: "https://shop.co/api/checkout-v2/submit", frozen: "shop.co/api/checkout-v2/submit" },
  { note: "underscored route with a version suffix", url: "https://shop.co/api/checkout_v2/submit", frozen: "shop.co/api/checkout_v2/submit" },
  { note: "underscored route, version first", url: "https://shop.co/api/v1_orders/create", frozen: "shop.co/api/v1_orders/create" },
  { note: "underscored route, digit at the end of a word", url: "https://shop.co/api/order_items2/add", frozen: "shop.co/api/order_items2/add" },
  { note: "hyphenated route, digits mid-name", url: "https://shop.co/api/b2b-orders/create", frozen: "shop.co/api/b2b-orders/create" },
  { note: "hyphenated route, digit inside a word", url: "https://shop.co/api/oauth2-callback/done", frozen: "shop.co/api/oauth2-callback/done" },
  { note: "unseparated route, digits in one run", url: "https://shop.co/api/oauth2callback/done", frozen: "shop.co/api/oauth2callback/done" },
  { note: "unseparated route naming an encoding", url: "https://shop.co/api/base64decode/run", frozen: "shop.co/api/base64decode/run" },
  { note: "camelCase route with a version digit", url: "https://shop.co/api/checkoutV2/submit", frozen: "shop.co/api/checkoutV2/submit" },
  { note: "camelCase route, digit at the end", url: "https://shop.co/api/addToCart2/run", frozen: "shop.co/api/addToCart2/run" },
  { note: "long camelCase route with a version digit", url: "https://shop.co/api/checkoutV2Submit/run", frozen: "shop.co/api/checkoutV2Submit/run" },
  { note: "camelCase route naming a service with a digit", url: "https://shop.co/api/getS3BucketUrl2/run", frozen: "shop.co/api/getS3BucketUrl2/run" },
  // A standard's name clears the density bar but carries its digits in one run — that is the half
  // of the density rule that keeps these alive.
  { note: "digest standard in a route name", url: "https://shop.co/api/SHA256Digest-v1/run", frozen: "shop.co/api/SHA256Digest-v1/run" },
  { note: "signature standard in a route name", url: "https://shop.co/api/Ed25519Sign-v1/run", frozen: "shop.co/api/Ed25519Sign-v1/run" },
  { note: "date standard in a route name", url: "https://shop.co/api/ISO8601Date-parse/run", frozen: "shop.co/api/ISO8601Date-parse/run" },
  { note: "camelCase route with one digit run", url: "https://shop.co/api/OAuth2Callback/run", frozen: "shop.co/api/OAuth2Callback/run" },
  // Names that scatter their digits TWICE. Reading these as generated is worse than it looks:
  // `sameEndpointShape` asks `isDynamicSegment` whether two requests are the same endpoint, so
  // cutting `step2Of3` would also make it one endpoint with `step3Of3` — and a 3-step checkout
  // would freeze a check that `/checkout/abandon` satisfies.
  { note: "ordinal-of-total step in a route name", url: "https://shop.co/api/checkout/step2Of3/submit", frozen: "shop.co/api/checkout/step2Of3/submit" },
  { note: "quarter-and-year report name", url: "https://shop.co/api/reports/Q1Report2026/export", frozen: "shop.co/api/reports/Q1Report2026/export" },
  { note: "campaign name carrying year and quarter", url: "https://shop.co/api/campaigns/Sale2024Q4/apply", frozen: "shop.co/api/campaigns/Sale2024Q4/apply" },
  { note: "two standards joined by a conversion — a name, and now read as one", url: "https://shop.co/api/utf8ToUtf16-conv/run", frozen: "shop.co/api/utf8ToUtf16-conv/run" },
  { note: "two standards listed in one name", url: "https://shop.co/api/P256AndP384/run", frozen: "shop.co/api/P256AndP384/run" },
  { note: "protocol versions in one name", url: "https://shop.co/api/IPv4ToIPv6/convert", frozen: "shop.co/api/IPv4ToIPv6/convert" },
  { note: "elliptic-curve standard in a route name (56% digits, under the one-run floor)", url: "https://shop.co/api/X25519Key-gen/run", frozen: "shop.co/api/X25519Key-gen/run" },
  { note: "dotted config slug is not a JWT (no digits, no mixed case)", url: "https://shop.co/cfg/production-cluster.service-registry.canary-rollout/get", frozen: "shop.co/cfg/production-cluster.service-registry.canary-rollout/get" },
  { note: "lowercase route naming a digest algorithm", url: "https://shop.co/api/sha256sum/run", frozen: "shop.co/api/sha256sum/run" },
  { note: "underscored route with words, not a random tail", url: "https://shop.co/api/user_profile_settings/read", frozen: "shop.co/api/user_profile_settings/read" },
  { note: "percent-encoded non-ASCII route", url: "https://shop.co/api/%E7%A2%BA%E8%AA%8D/submit", frozen: "shop.co/api/%E7%A2%BA%E8%AA%8D/submit" },
  { note: "short version segment", url: "https://shop.co/api/v2/cart?x=1", frozen: "shop.co/api/v2/cart" },
  { note: "long alphabetic segment (no digit)", url: "https://shop.co/api/subscriptions/cancel", frozen: "shop.co/api/subscriptions/cancel" },
  { note: "a word that spells hex is not a digest", url: "https://shop.co/api/facade-decade/run", frozen: "shop.co/api/facade-decade/run" },
  { note: "numeric part code is not a date (month range)", url: "https://shop.co/parts/1234-56/order", frozen: "shop.co/parts/1234-56/order" },
  { note: "numeric SKU is not a date (year range)", url: "https://shop.co/sku/1000-01/buy", frozen: "shop.co/sku/1000-01/buy" },
  // A short number inside a named route is a qualifier — an ordinal, a version, a tier, a year, an
  // error code. Cutting these made a 2nd-step check pass on the 1st step, and on /checkout/abandon.
  { note: "ordinal step in a multi-step flow", url: "https://shop.co/checkout/step-2/submit", frozen: "shop.co/checkout/step-2/submit" },
  { note: "ranked list route", url: "https://shop.co/api/top-100/list", frozen: "shop.co/api/top-100/list" },
  { note: "tier route", url: "https://shop.co/api/tier-1/upgrade", frozen: "shop.co/api/tier-1/upgrade" },
  { note: "name that carries a year", url: "https://shop.co/api/covid-19/stats", frozen: "shop.co/api/covid-19/stats" },
  { note: "error-code route", url: "https://shop.co/api/error-404/report", frozen: "shop.co/api/error-404/report" },
  { note: "campaign year in a name", url: "https://shop.co/api/sale-2024/list", frozen: "shop.co/api/sale-2024/list" },
  { note: "protocol version with a separator", url: "https://shop.co/api/oauth-2/callback", frozen: "shop.co/api/oauth-2/callback" },
  { note: "encoding name with a separator", url: "https://shop.co/api/utf-8/encode", frozen: "shop.co/api/utf-8/encode" },
  { note: "underscored pagination route", url: "https://shop.co/api/page_2/next", frozen: "shop.co/api/page_2/next" },
  // KNOWN GAPS — an id the rule does not recognize stays frozen, so #172 bites in these shapes:
  // the frozen check can never match again, and outcome-heal re-judges against it every run
  // (run.ts:229), so the cost is repeated LLM calls, not one loud failure. Kept anyway because the
  // alternative — cutting these — would also cut real route names and pass on the wrong request.
  // Capitalized ids are recognized now (ULID/JWT by shape, the rest by digit density), so what is
  // left is what density cannot separate from a name: short slugs and digit-sparse tokens.
  { note: "KNOWN GAP: short id keeps the run-specific value", url: "https://shop.co/api/orders/a3f9/confirm", frozen: "shop.co/api/orders/a3f9/confirm" },
  { note: "KNOWN GAP: digit-free prefixed id", url: "https://shop.co/orders/ord_abcdef/confirm", frozen: "shop.co/orders/ord_abcdef/confirm" },
  { note: "KNOWN GAP: digit-free base64 slug", url: "https://shop.co/r/YWJjZGVm/confirm", frozen: "shop.co/r/YWJjZGVm/confirm" },
  { note: "KNOWN GAP: Stripe customer id (real format)", url: "https://shop.co/c/cus_NffrFeUfNV2Hib/confirm", frozen: "shop.co/c/cus_NffrFeUfNV2Hib/confirm" },
  { note: "KNOWN GAP: KSUID (real format)", url: "https://shop.co/o/0ujtsYcgvSTl8PAuAdqWYSMnLOv/confirm", frozen: "shop.co/o/0ujtsYcgvSTl8PAuAdqWYSMnLOv/confirm" },
  { note: "KNOWN GAP: Hashids slug (real format)", url: "https://shop.co/s/o2fXhV/confirm", frozen: "shop.co/s/o2fXhV/confirm" },
  // Numbers joined by a separator are read as qualifiers unless a group reaches five digits — so
  // an order/invoice/part number split into short groups survives.
  { note: "KNOWN GAP: dash-joined numeric groups all under six digits", url: "https://shop.co/o/order-1234/confirm", frozen: "shop.co/o/order-1234/confirm" },
  { note: "KNOWN GAP: grouped order number", url: "https://shop.co/o/12-345-678/confirm", frozen: "shop.co/o/12-345-678/confirm" },
  { note: "KNOWN GAP: a five-digit id group — the cost of raising the floor to six for CVE-2024-21413", url: "https://shop.co/o/order-12345/confirm", frozen: "shop.co/o/order-12345/confirm" },
  { note: "KNOWN GAP: a monthly report path — the cost of keeping YYYY-MM as a name", url: "https://shop.co/api/reports/2026-08/export", frozen: "shop.co/api/reports/2026-08/export" },
  { note: "one group of five digits is enough to cut", url: "https://shop.co/o/978-3-16-148410-0/confirm", frozen: "shop.co/o" },
  // Only the ISO forms are recognized as dates; the rest freeze verbatim and go red the next day.
  { note: "KNOWN GAP: US date order", url: "https://shop.co/api/reports/08-27-2026/export", frozen: "shop.co/api/reports/08-27-2026/export" },
  { note: "KNOWN GAP: dotted date", url: "https://shop.co/api/reports/2026.08.27/export", frozen: "shop.co/api/reports/2026.08.27/export" },
  { note: "KNOWN GAP: full timestamp — fails within the same day", url: "https://shop.co/api/t/2026-08-27T10:00:00Z/ack", frozen: "shop.co/api/t/2026-08-27T10:00:00Z/ack" },
  // The mixed-case family — the widest gap, and these are mainstream id generators, not exotica.
  { note: "KNOWN GAP: base62 slug too short to read as generated", url: "https://shop.co/o/x7Kp2Qw/confirm", frozen: "shop.co/o/x7Kp2Qw/confirm" },
  { note: "KNOWN GAP: a long token whose digits are too sparse", url: "https://shop.co/o/AbcdefghijKlmnop1/confirm", frozen: "shop.co/o/AbcdefghijKlmnop1/confirm" },
  { note: "KNOWN GAP: a digit-sparse base62 video-style id", url: "https://shop.co/v/dQw4w9WgXcQ/watch", frozen: "shop.co/v/dQw4w9WgXcQ/watch" },
  { note: "KNOWN GAP: a nanoid split by its own separators — two runs per piece, under the scatter floor", url: "https://shop.co/o/V1StGXR8_Z5jdHi6B-myT/confirm", frozen: "shop.co/o/V1StGXR8_Z5jdHi6B-myT/confirm" },
  { note: "KNOWN GAP: two digit runs at 50% — scattered, but not scattered enough", url: "https://shop.co/o/AbCd1234EfGh5678/confirm", frozen: "shop.co/o/AbCd1234EfGh5678/confirm" },
  { note: "KNOWN GAP: a word-prefixed key too sparse for the one-run floor", url: "https://shop.co/o/CustomerA1234567/confirm", frozen: "shop.co/o/CustomerA1234567/confirm" },
  // KNOWN FALSE POSITIVE, the other direction — one left. Three parts of base64url with mixed case
  // is a JWT's shape and also a .NET-style namespace's, and nothing in the string tells them apart.
  { note: "KNOWN FALSE POSITIVE: PascalCase namespace reads as a JWT (mixed case, three parts)", url: "https://shop.co/cfg/MyCompanyApp.ServiceRegistry.CanaryRollout/get", frozen: "shop.co/cfg" },
  { note: "KNOWN GAP: base62 session slug (the realistic form of the sess- case above)", url: "https://shop.co/s/sess-k9m2p4q7/resume", frozen: "shop.co/s/sess-k9m2p4q7/resume" },
  { note: "KNOWN GAP: prefixed id with a non-hex letter", url: "https://shop.co/orders/ord_8f3a2k/confirm", frozen: "shop.co/orders/ord_8f3a2k/confirm" },
  { note: "KNOWN GAP: percent-encoded short id", url: "https://shop.co/api/q/%7B%22id%22%3A999%7D/run", frozen: "shop.co/api/q/%7B%22id%22%3A999%7D/run" },
  { note: "token that is all hex chars is cut by the digest rule", url: "https://shop.co/r/abc12345/confirm", frozen: "shop.co/r" },
  // QUERY-DISPATCH APIs — the path names no action, so the leading run of stable query params is
  // kept; without it any other POST to the same endpoint satisfies the check (false GREEN).
  { note: "graphql operation name is kept", url: "https://shop.co/graphql?op=AddToCart", frozen: "shop.co/graphql?op=AddToCart" },
  { note: "a different operation on the same endpoint stays distinct", url: "https://shop.co/graphql?op=Heartbeat", frozen: "shop.co/graphql?op=Heartbeat" },
  { note: "rpc action kept, run-specific tail dropped", url: "https://shop.co/rpc?action=checkout&sid=a1b2c3d4e5", frozen: "shop.co/rpc?action=checkout" },
  { note: "several stable params are all kept", url: "https://shop.co/rpc?action=checkout&mode=express", frozen: "shop.co/rpc?action=checkout&mode=express" },
  { note: "leading run only: a run-specific first param drops the whole query", url: "https://shop.co/rpc?sid=a1b2c3d4e5&action=checkout", frozen: "shop.co/rpc" },
  { note: "valueless param drops the query", url: "https://shop.co/rpc?debug&action=checkout", frozen: "shop.co/rpc" },
  { note: "a cut path takes no query (it is a prefix, not a suffix)", url: "https://shop.co/api/orders/586738/confirm?op=Confirm", frozen: "shop.co/api/orders" },
  { note: "trailing slash before the query keeps the path only", url: "https://shop.co/rpc/?action=checkout", frozen: "shop.co/rpc" },
  // hosts
  { note: "port is part of the host", url: "http://localhost:3000/api/cart?x=1", frozen: "localhost:3000/api/cart" },
  // THE CUT ALSO TAKES THE VERB. Everything after the first run-minted segment goes with it, and in
  // REST that is the action itself: `/orders/{id}/confirm` and `/orders/{id}/cancel` freeze to the
  // same value. When ONE run shows both, grounding now drops the check rather than freeze a value
  // that cannot tell them apart; these rows are what the transform still produces when only one of
  // them is observed, and a replay firing the other verb would satisfy it. Substring matching
  // cannot express "this prefix AND that suffix"; naming the endpoint by parts would.
  { note: "VERB LOST: confirm freezes to the collection", url: "https://shop.co/api/orders/111/confirm", frozen: "shop.co/api/orders" },
  { note: "VERB LOST: cancel freezes to the same value", url: "https://shop.co/api/orders/222/cancel", frozen: "shop.co/api/orders" },
  // WEAK BUT KEPT: one surviving segment is close to host-level — `shop.co/api` matches every
  // sibling endpoint under /api. The drop guard below only refuses a prefix with NO path at all.
  { note: "WEAK: an id in the second segment leaves a near-host prefix", url: "https://shop.co/api/586738/confirm", frozen: "shop.co/api" },
  // nothing stable left → the assertion is dropped, not frozen host-only
  { note: "first path segment is an id → no stable path", url: "https://api.shop.co/586738", frozen: null },
  { note: "root POST → no stable path", url: "https://api.shop.co/", frozen: null },
];
