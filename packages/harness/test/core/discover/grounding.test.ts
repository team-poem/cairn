import { describe, expect, it } from "vitest";
import { deriveAssertions, markVacuous } from "../../../src/core/discover/grounding.js";
import type { Evidence } from "../../../src/core/types.js";
import { findRequestStatus } from "../../../src/core/requests.js";
import { urlReached } from "../../../src/core/steps.js";
import { STABLE_PREFIX_CORPUS } from "../../support/url-corpus.js";

const evidence: Evidence = {
  execution: { actions: [], navigated: true, finalUrl: "https://shop/products", blocked: false },
  perception: {},
  logic: {
    requests: [{ method: "POST", url: "https://shop/api/cart", status: 201 }],
    console: [],
  },
};

describe("deriveAssertions provenance", () => {
  it("stamps origin: derived on every grounded assertion — defaults, kept proposals, semantic expects", () => {
    const out = deriveAssertions(
      [
        { kind: "request-status", urlIncludes: "/api/cart", status: 201 },
        { kind: "expect", criterion: "cart shows the item" },
      ],
      evidence,
      true,
    );
    // All four families survive grounding here: no-failed-requests, no-console-errors,
    // navigated, the matched request-status, and the semantic expect.
    expect(out.map((a) => a.kind)).toEqual(
      expect.arrayContaining(["no-failed-requests", "navigated", "request-status", "expect"]),
    );
    for (const a of out) expect(a.origin).toBe("derived");
  });
});

describe("markVacuous (#137) — checks the starting state already satisfies", () => {
  const baseline = (over: Partial<Evidence["logic"]> = {}, finalUrl = "https://app/start"): Evidence => ({
    execution: { actions: [], navigated: false, finalUrl, blocked: false },
    perception: {},
    logic: { requests: [{ method: "GET", url: "https://app/api/boot", status: 200 }], console: [], ...over },
  });

  it("flags a request-status a landing-page request already satisfies (monotone log)", () => {
    const out = markVacuous([{ kind: "request-status", urlIncludes: "/api/boot", status: 200 }], baseline());
    expect(out[0]?.vacuous).toBe(true);
  });

  it("does not flag a request-status nothing at the start satisfies", () => {
    const out = markVacuous([{ kind: "request-status", urlIncludes: "/api/order", status: 201, method: "POST" }], baseline());
    expect(out[0]?.vacuous).toBeUndefined();
  });

  it("flags a navigated whose destination the entry URL already reaches", () => {
    const out = markVacuous([{ kind: "navigated", to: "app/start" }], baseline());
    expect(out[0]?.vacuous).toBe(true);
  });

  it("does not flag a navigated to somewhere the flow must actually reach", () => {
    const out = markVacuous([{ kind: "navigated", to: "app/checkout/complete" }], baseline());
    expect(out[0]?.vacuous).toBeUndefined();
  });

  it("bare navigated (no destination) is never vacuous", () => {
    const out = markVacuous([{ kind: "navigated" }], baseline());
    expect(out[0]?.vacuous).toBeUndefined();
  });

  it("guards hold on a clean start and carry the flag (for the all-vacuous gate)", () => {
    const out = markVacuous([{ kind: "no-failed-requests" }, { kind: "no-console-errors" }], baseline());
    expect(out.every((a) => a.vacuous)).toBe(true);
  });

  it("a guard is not vacuous when the start was already dirty", () => {
    const dirty = baseline({ requests: [{ method: "GET", url: "https://app/api/boot", status: 500 }] });
    const out = markVacuous([{ kind: "no-failed-requests" }], dirty);
    expect(out[0]?.vacuous).toBeUndefined();
  });

  it("never flags expect/custom — the freeze has no judge for them", () => {
    const out = markVacuous(
      [{ kind: "expect", criterion: "looks right" }, { kind: "custom", name: "cart-has" }],
      baseline(),
    );
    expect(out.every((a) => a.vacuous === undefined)).toBe(true);
  });
});

describe("request-status grounding freezes a replayable URL (#172)", () => {
  const evidenceWith = (requests: Evidence["logic"]["requests"]): Evidence => ({
    execution: { actions: [], navigated: false, finalUrl: "https://shop.co/cart", blocked: false },
    perception: {},
    logic: { requests, console: [] },
  });

  it("freezes the endpoint prefix, not the run-specific query the model proposed", () => {
    // The regression: the same add-to-cart POST fired twice, so the model pinned each firing by
    // full URL. Freezing that verbatim pins a one-shot id — no replay can ever satisfy it, and
    // outcome-heal re-judges against the same pinned assertion, so the FAIL is permanent.
    const out = deriveAssertions(
      [
        { kind: "request-status", urlIncludes: "/cart/add-carts?buyRequestIds=586738", status: 200 },
        { kind: "request-status", urlIncludes: "/cart/add-carts?buyRequestIds=586739", status: 200 },
      ],
      evidenceWith([
        { method: "POST", url: "https://shop.co/cart/add-carts?buyRequestIds=586738", status: 200 },
        { method: "POST", url: "https://shop.co/cart/add-carts?buyRequestIds=586739", status: 200 },
      ]),
      false,
    );
    const kept = out.filter((a) => a.kind === "request-status");
    // Both proposals collapse into one replayable check.
    expect(kept).toEqual([
      { kind: "request-status", urlIncludes: "shop.co/cart/add-carts", status: 200, method: "POST", origin: "derived" },
    ]);
  });

  it("the frozen check still matches a later run's own ids", () => {
    const frozen = deriveAssertions(
      [{ kind: "request-status", urlIncludes: "/cart/add-carts?buyRequestIds=586738", status: 200 }],
      evidenceWith([{ method: "POST", url: "https://shop.co/cart/add-carts?buyRequestIds=586738", status: 200 }]),
      false,
    ).find((a) => a.kind === "request-status");
    const replay = { method: "POST", url: "https://shop.co/cart/add-carts?buyRequestIds=999001", status: 200 };
    expect(findRequestStatus([replay], frozen!.urlIncludes, frozen!.status, frozen!.method)).toBe(replay);
  });

  it("keeps a non-mutation check method-free (a GET proof freezes no method)", () => {
    const out = deriveAssertions(
      [{ kind: "request-status", urlIncludes: "/api/cart?token=abc12345", status: 200 }],
      evidenceWith([{ method: "GET", url: "https://shop.co/api/cart?token=abc12345", status: 200 }]),
      false,
    );
    expect(out).toContainEqual({
      kind: "request-status",
      urlIncludes: "shop.co/api/cart",
      status: 200,
      origin: "derived",
    });
  });

  it("drops a match whose URL leaves no stable path, with a reason on the trace", () => {
    const drops: string[] = [];
    const out = deriveAssertions(
      [{ kind: "request-status", urlIncludes: "/586738", status: 201 }],
      evidenceWith([{ method: "POST", url: "https://api.shop.co/586738", status: 201 }]),
      false,
      [],
      (_a, reason) => drops.push(reason),
    );
    expect(out.some((a) => a.kind === "request-status")).toBe(false);
    expect(drops[0]).toMatch(/no stable path/);
  });

  it("normalizing can newly expose a vacuous check the pinned URL hid (#137 interaction)", () => {
    // The baseline fired the same endpoint with a different query. Pre-#172 the frozen URL carried
    // the flow's own id, so the overlap was invisible; the grounded prefix makes it visible, and a
    // check the starting state already satisfies must be flagged, not silently frozen green.
    const grounded = deriveAssertions(
      [{ kind: "request-status", urlIncludes: "/api/track?e=2", status: 200 }],
      evidenceWith([{ method: "POST", url: "https://shop.co/api/track?e=2", status: 200 }]),
      false,
    );
    const baseline: Evidence = {
      execution: { actions: [], navigated: false, finalUrl: "https://shop.co/cart", blocked: false },
      perception: {},
      logic: { requests: [{ method: "POST", url: "https://shop.co/api/track?e=1", status: 200 }], console: [] },
    };
    const marked = markVacuous(grounded, baseline).filter((a) => a.kind === "request-status");
    expect(marked[0]?.vacuous).toBe(true);
  });

  describe("URL-corpus: what a captured request freezes to", () => {
    for (const c of STABLE_PREFIX_CORPUS) {
      it(`${c.note} → ${c.frozen ?? "dropped"}`, () => {
        const out = deriveAssertions(
          [{ kind: "request-status", urlIncludes: c.url, status: 201 }],
          evidenceWith([{ method: "POST", url: c.url, status: 201 }]),
          false,
        ).filter((a) => a.kind === "request-status");
        if (c.frozen === null) expect(out).toEqual([]);
        else expect(out[0]?.urlIncludes).toBe(c.frozen);
      });
    }
  });
});

describe("what normalization costs (pinned, not endorsed)", () => {
  const ev = (requests: Evidence["logic"]["requests"]): Evidence => ({
    execution: { actions: [], navigated: false, finalUrl: "https://shop.co/orders", blocked: false },
    perception: {},
    logic: { requests, console: [] },
  });

  it("drops both checks when the cut would merge a confirm and a cancel", () => {
    // /api/orders/{id}/confirm and /api/orders/{id}/cancel both cut to host/api/orders. Freezing
    // that would let a scenario proving a confirm pass on a cancel, so neither is frozen — the run
    // itself shows the value no longer tells the two apart.
    const drops: string[] = [];
    const out = deriveAssertions(
      [
        { kind: "request-status", urlIncludes: "/api/orders/111/confirm", status: 200 },
        { kind: "request-status", urlIncludes: "/api/orders/222/cancel", status: 200 },
      ],
      ev([
        { method: "POST", url: "https://shop.co/api/orders/111/confirm", status: 200 },
        { method: "POST", url: "https://shop.co/api/orders/222/cancel", status: 200 },
      ]),
      false,
      [],
      (_a, reason) => drops.push(reason),
    );
    expect(out.filter((a) => a.kind === "request-status")).toEqual([]);
    expect(drops[0]).toMatch(/different endpoint than the one proposed/);
  });

  it("still keeps the check when the extra matches are the SAME action fired twice", () => {
    // The widening #172 exists for: two firings of one add-to-cart, told apart by a run-minted id.
    const out = deriveAssertions(
      [{ kind: "request-status", urlIncludes: "/cart/add?ids=586738", status: 200 }],
      ev([
        { method: "POST", url: "https://shop.co/cart/add?ids=586738", status: 200 },
        { method: "POST", url: "https://shop.co/cart/add?ids=586739", status: 200 },
      ]),
      false,
    );
    expect(out).toContainEqual({
      kind: "request-status",
      urlIncludes: "shop.co/cart/add",
      status: 200,
      method: "POST",
      origin: "derived",
    });
  });

  it("a read on a sibling path does not spend a write-bound check", () => {
    // The frozen check carries POST; a GET on a neighbouring path could never satisfy it, so it is
    // not a collision. Judging the collision without the method dropped these three shapes.
    const out = deriveAssertions(
      [{ kind: "request-status", urlIncludes: "/api/checkout", status: 200 }],
      ev([
        { method: "POST", url: "https://shop.co/api/checkout", status: 200 },
        { method: "GET", url: "https://shop.co/api/checkout/status", status: 200 },
      ]),
      false,
    );
    expect(out).toContainEqual({
      kind: "request-status",
      urlIncludes: "shop.co/api/checkout",
      status: 200,
      method: "POST",
      origin: "derived",
    });
  });

  it("…and a same-method sibling still spends it", () => {
    const out = deriveAssertions(
      [{ kind: "request-status", urlIncludes: "/api/orders/111/confirm", status: 200 }],
      ev([
        { method: "POST", url: "https://shop.co/api/orders/111/confirm", status: 200 },
        { method: "POST", url: "https://shop.co/api/orders/222/cancel", status: 200 },
      ]),
      false,
    );
    expect(out.some((x) => x.kind === "request-status")).toBe(false);
  });

  it("drops a read-only flow's check the page's own list request already satisfies", () => {
    // The maintainer's case: nothing to prefer as a mutation, and the widened prefix is answered by
    // the list the page loaded — a replay that never opens the detail would pass.
    const drops: string[] = [];
    const out = deriveAssertions(
      [{ kind: "request-status", urlIncludes: "/api/products/586738", status: 200 }],
      ev([
        { method: "GET", url: "https://shop.co/api/products", status: 200 },
        { method: "GET", url: "https://shop.co/api/products/586738", status: 200 },
      ]),
      false,
      [],
      (_a, reason) => drops.push(reason),
    );
    expect(out.some((a) => a.kind === "request-status")).toBe(false);
    expect(drops[0]).toMatch(/GET https:\/\/shop.co\/api\/products/);
  });

  it("a still-in-flight request is never frozen as proof", () => {
    const drops: string[] = [];
    const out = deriveAssertions(
      [{ kind: "request-status", urlIncludes: "/api/orders", status: 0 }],
      ev([{ method: "POST", url: "https://shop.co/api/orders/586738", status: 0 }]),
      false,
      [],
      (_a, reason) => drops.push(reason),
    );
    expect(out.some((a) => a.kind === "request-status")).toBe(false);
    expect(drops[0]).toMatch(/not a settled success/);
  });
});

describe("grounding matches the proposal's method (#178 review)", () => {
  const ev = (requests: Evidence["logic"]["requests"]): Evidence => ({
    execution: { actions: [], navigated: false, finalUrl: "https://api.test/done", blocked: false },
    perception: {},
    logic: { requests, console: [] },
  });

  it("a read does not ground a proposal that asked for a write", () => {
    // Without the method, GET /api/jobs 200 answers a POST proposal, and #105 then freezes no
    // method (the match is not a mutation) — leaving a check any read satisfies.
    const drops: string[] = [];
    const out = deriveAssertions(
      [{ kind: "request-status", urlIncludes: "/api/jobs", status: 200, method: "POST" }],
      ev([{ method: "GET", url: "https://api.test/api/jobs", status: 200 }]),
      false,
      [],
      (_a, reason) => drops.push(reason),
    );
    expect(out.some((a) => a.kind === "request-status")).toBe(false);
    expect(drops[0]).toMatch(/no captured request matched/);
  });

  it("the same proposal grounds on the write when one is there", () => {
    const out = deriveAssertions(
      [{ kind: "request-status", urlIncludes: "/api/jobs", status: 200, method: "POST" }],
      ev([
        { method: "GET", url: "https://api.test/api/jobs", status: 200 },
        { method: "POST", url: "https://api.test/api/jobs", status: 200 },
      ]),
      false,
    );
    expect(out).toContainEqual({
      kind: "request-status",
      urlIncludes: "api.test/api/jobs",
      status: 200,
      method: "POST",
      origin: "derived",
    });
  });

  it("a proposal with no method still grounds on whatever matched", () => {
    const out = deriveAssertions(
      [{ kind: "request-status", urlIncludes: "/api/jobs", status: 200 }],
      ev([{ method: "GET", url: "https://api.test/api/jobs", status: 200 }]),
      false,
    );
    expect(out).toContainEqual({
      kind: "request-status",
      urlIncludes: "api.test/api/jobs",
      status: 200,
      origin: "derived",
    });
describe("navigated freezes a destination a later run can still reach (#172 on the URL path)", () => {
  const ranTo = (finalUrl: string): Evidence => ({
    execution: { actions: [], navigated: true, finalUrl, blocked: false },
    perception: {},
    logic: { requests: [], console: [] },
  });

  it("writes a wildcard where the run minted the segment", () => {
    const out = deriveAssertions([], ranTo("https://shop.co/orders/586738/done"), false);
    expect(out).toContainEqual({ kind: "navigated", to: "shop.co/orders/*/done", origin: "derived" });
  });

  it("the frozen destination matches the discovering run AND the next one", () => {
    const to = deriveAssertions([], ranTo("https://shop.co/orders/586738/done"), false).find(
      (a) => a.kind === "navigated",
    )?.to;
    expect(urlReached("https://shop.co/orders/586738/done", to!)).toBe(true);
    expect(urlReached("https://shop.co/orders/999001/done", to!)).toBe(true);
    // and it still catches landing somewhere else
    expect(urlReached("https://shop.co/orders/999001/cancel", to!)).toBe(false);
  });

  it("a destination with no run-minted segment freezes exactly as before", () => {
    const out = deriveAssertions([], ranTo("https://shop.co/checkout/complete"), false);
    expect(out).toContainEqual({ kind: "navigated", to: "shop.co/checkout/complete", origin: "derived" });
  });
});

describe("which request proves the action, and which method is frozen (#178 review)", () => {
  const ev = (requests: Evidence["logic"]["requests"]): Evidence => ({
    execution: { actions: [], navigated: false, finalUrl: "https://api.test/done", blocked: false },
    perception: {},
    logic: { requests, console: [] },
  });
  const bothVerbs = [
    { method: "GET", url: "https://api.test/api/jobs", status: 200 },
    { method: "POST", url: "https://api.test/api/jobs", status: 200 },
  ];
  const proposal = { kind: "request-status" as const, urlIncludes: "/api/jobs", status: 200 };
  const frozen = (requests: Evidence["logic"]["requests"], a = proposal) =>
    deriveAssertions([a], ev(requests), false).find((x) => x.kind === "request-status");

  it("prefers the mutation when the proposal names no method — whichever arrived first", () => {
    // Otherwise the network decides whether the frozen check binds to a verb: same evidence, two
    // different freezes. The prompt's own example JSON carries no method, so this is the norm.
    expect(frozen(bothVerbs)?.method).toBe("POST");
    expect(frozen([...bothVerbs].reverse())?.method).toBe("POST");
  });

  it("keeps an explicitly proposed GET instead of widening it to any verb", () => {
    const asGet = { ...proposal, method: "GET" };
    const out = frozen([{ method: "GET", url: "https://api.test/api/jobs", status: 200 }], asGet);
    expect(out?.method).toBe("GET");
  });

  it("freezes no method when only a read matched and none was asked for", () => {
    expect(frozen([{ method: "GET", url: "https://api.test/api/jobs", status: 200 }])?.method).toBeUndefined();
  });

  it("refuses to freeze a failure as the success condition", () => {
    const drops: string[] = [];
    const out = deriveAssertions(
      [{ kind: "request-status", urlIncludes: "/api/orders", status: 500, method: "POST" }],
      ev([{ method: "POST", url: "https://api.test/api/orders", status: 500 }]),
      false,
      [],
      (_a, reason) => drops.push(reason),
    );
    expect(out.some((x) => x.kind === "request-status")).toBe(false);
    expect(drops[0]).toMatch(/not a settled success/);
  });

  it("names the method in the drop reason — the URL and status did match something", () => {
    const drops: string[] = [];
    deriveAssertions(
      [{ ...proposal, method: "POST" }],
      ev([{ method: "GET", url: "https://api.test/api/jobs", status: 200 }]),
      false,
      [],
      (_a, reason) => drops.push(reason),
    );
    expect(drops[0]).toContain("(POST)");
  });

  it("reports a proposed destination the run did not reach", () => {
    const drops: string[] = [];
    deriveAssertions(
      [{ kind: "navigated", to: "app.test/success" }],
      {
        execution: { actions: [], navigated: true, finalUrl: "https://app.test/error", blocked: false },
        perception: {},
        logic: { requests: [], console: [] },
      },
      false,
      [],
      (_a, reason) => drops.push(reason),
    );
    expect(drops[0]).toMatch(/reached app.test\/error, not app.test\/success/);
  });
});

describe("noise cannot prove an action (#178 review)", () => {
  const beacon = { method: "POST", url: "https://analytics.co/collect", status: 200 };
  const ev = (requests: Evidence["logic"]["requests"]): Evidence => ({
    execution: { actions: [], navigated: false, finalUrl: "https://shop.co/done", blocked: false },
    perception: {},
    logic: { requests, console: [] },
  });
  const proposal = { kind: "request-status" as const, urlIncludes: "analytics.co/collect", status: 200 };

  it("a product-marked endpoint cannot ground a proof", () => {
    // benign means "its failure does not count" for no-failed-requests, and "it is incidental" here.
    // Freezing it would make a tracking beacon the evidence the order was placed.
    const drops: string[] = [];
    const out = deriveAssertions([proposal], ev([beacon]), false, ["analytics.co"], (_a, r) => drops.push(r));
    expect(out.some((a) => a.kind === "request-status")).toBe(false);
    // …and the reason says which way it failed: the request was there, it was set aside as noise.
    expect(drops[0]).toMatch(/is on an endpoint marked benign/);
  });

  it("…and the same proposal still grounds when the product marked nothing", () => {
    expect(deriveAssertions([proposal], ev([beacon]), false)).toContainEqual({
      kind: "request-status",
      urlIncludes: "analytics.co/collect",
      status: 200,
      method: "POST",
      origin: "derived",
    });
  });

  it("a beacon does not stand in for the real action when both fired", () => {
    const real = { method: "POST", url: "https://shop.co/api/orders", status: 201 };
    const out = deriveAssertions(
      [{ kind: "request-status", urlIncludes: "/api/orders", status: 201 }],
      ev([beacon, real]),
      false,
      ["analytics.co"],
    );
    expect(out).toContainEqual({
      kind: "request-status",
      urlIncludes: "shop.co/api/orders",
      status: 201,
      method: "POST",
      origin: "derived",
    });
  });
});

describe("the destination-mismatch signal ignores formatting (#178 review)", () => {
  const ranTo = (finalUrl: string): Evidence => ({
    execution: { actions: [], navigated: true, finalUrl, blocked: false },
    perception: {},
    logic: { requests: [], console: [] },
  });
  const dropsFor = (to: string): string[] => {
    const drops: string[] = [];
    deriveAssertions([{ kind: "navigated", to }], ranTo("https://app.test/error"), false, [], (_a, r) =>
      drops.push(r),
    );
    return drops;
  };

  it("says nothing when the proposal names the same page with a scheme or a trailing slash", () => {
    expect(dropsFor("https://app.test/error")).toEqual([]);
    expect(dropsFor("app.test/error/")).toEqual([]);
  });

  it("still reports a real mismatch", () => {
    expect(dropsFor("app.test/success")[0]).toMatch(/reached app.test\/error, not app.test\/success/);
  });
});

describe("query-dispatch endpoints keep their operation", () => {
  it("two operations on one endpoint stay two distinct checks", () => {
    // /graphql (or an ?action= RPC) names no action in its path, so dropping the query whole left
    // a check that any other POST to the endpoint — a heartbeat, a session refresh — satisfies.
    const out = deriveAssertions(
      [
        { kind: "request-status", urlIncludes: "/graphql?op=AddToCart", status: 200 },
        { kind: "request-status", urlIncludes: "/graphql?op=Heartbeat", status: 200 },
      ],
      {
        execution: { actions: [], navigated: false, finalUrl: "https://shop.co/cart", blocked: false },
        perception: {},
        logic: {
          requests: [
            { method: "POST", url: "https://shop.co/graphql?op=AddToCart", status: 200 },
            { method: "POST", url: "https://shop.co/graphql?op=Heartbeat", status: 200 },
          ],
          console: [],
        },
      },
      false,
    );
    expect(out.filter((a) => a.kind === "request-status").map((a) => a.urlIncludes)).toEqual([
      "shop.co/graphql?op=AddToCart",
      "shop.co/graphql?op=Heartbeat",
    ]);
    // An unrelated operation must not satisfy the frozen check.
    expect(
      findRequestStatus(
        [{ method: "POST", url: "https://shop.co/graphql?op=RefreshSession", status: 200 }],
        "shop.co/graphql?op=AddToCart",
        200,
        "POST",
      ),
    ).toBeUndefined();
  });

  it("still drops the run-specific value that motivated #172", () => {
    const out = deriveAssertions(
      [{ kind: "request-status", urlIncludes: "/cart/add?buyRequestIds=586738", status: 200 }],
      {
        execution: { actions: [], navigated: false, finalUrl: "https://shop.co/cart", blocked: false },
        perception: {},
        logic: {
          requests: [{ method: "POST", url: "https://shop.co/cart/add?buyRequestIds=586738", status: 200 }],
          console: [],
        },
      },
      false,
    );
    expect(out.find((a) => a.kind === "request-status")?.urlIncludes).toBe("shop.co/cart/add");
  });
});
