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
