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
