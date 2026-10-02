# Example app context: local shop

> Proposal example for discussion #238. Cairn does not currently load this document as a supported
> configuration file. A host can use it as human-authored context when preparing an intent.

## What this is

The stateful tier of the [`bench/local` fixture](../../bench/local/server.mjs) is a small shop flow
for measuring discovery and replay locally. It serves one fixed book product and an isolated
session-backed order journey. This description is context, not a browser action script or a fixture
configuration format.

## Flows

- Start at `/login` and submit the synthetic username `alice` to reach `/products`.
- On `/products`, use **Add to cart** to add one book (`sku: book`, quantity `1`), then follow
  **Cart** to `/cart`.
- **Place order** submits the order. The fixture completes at `/done` after the order is accepted.
- Ordering requires a logged-in session with exactly one book in its cart. An unauthenticated
  order is rejected; an empty or multi-book cart cannot place one.

## Vocabulary

The v1 pages call the login field **Username**, the login button **Log in**, the product action
**Add to cart**, the cart link **Cart**, and the order action **Place order**. The cart shows the
current book count as **Books: 1**. Fixture version v2 deliberately renames some labels to test
replay across UI text changes; those alternate labels are not separate products or flows.

## Environment

The local runner starts a fresh fixture server at a dynamically assigned origin such as
`http://127.0.0.1:<port>`. Each fixture instance has isolated session and order state; use the
origin returned by the fixture rather than assuming a fixed port. `alice` is a synthetic test
username accepted by this fixture. There is no password field and no real account or credential.

If adapting the example to an app that needs real credentials, use the existing [`{name}` secret
placeholder](../guide.md#secrets) in the intent and supply the value separately through the
supported `secrets` option or CLI secret mechanism. Do not put a real credential in this document.

## Never

Never use a real account or credential for this local fixture. This section is human-authored
guidance for a reader or model; prose does not enforce an execution restriction. If discovery must
block an action deterministically, the host must provide an [`ActionPolicy`](../../packages/harness/src/core/discover/decision.ts)
that rejects it before execution. That policy applies to discovery decisions; this document does
not add a new enforcement mechanism or claim that the engine loads these sections as configuration.
