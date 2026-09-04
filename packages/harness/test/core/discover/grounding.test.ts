import { describe, expect, it } from "vitest";
import { deriveAssertions, findUnprovenAction, markVacuous } from "../../../src/core/discover/grounding.js";
import type { Assertion, Evidence } from "../../../src/core/types.js";
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
  });
});

describe("an action no check can express is recorded, not swallowed", () => {
  const evWith = (requests: Evidence["logic"]["requests"]): Evidence => ({
    execution: { actions: [], navigated: true, finalUrl: "https://shop.co/done", blocked: false },
    perception: {},
    logic: { requests, console: [] },
  });
  const navigated: Assertion[] = [{ kind: "navigated", to: "shop.co/done" }];
  const rootDelete = { method: "DELETE", url: "https://api.shop.co/586738", status: 200 };

  it("names a successful same-site mutation whose URL leaves no stable path", () => {
    expect(findUnprovenAction(evWith([rootDelete]), navigated)).toEqual(rootDelete);
  });

  it("stays quiet once a real proof was frozen — the flow is verified either way", () => {
    const assertions: Assertion[] = [
      { kind: "request-status", urlIncludes: "shop.co/api/orders", status: 200, method: "POST" },
    ];
    expect(findUnprovenAction(evWith([rootDelete]), assertions)).toBeUndefined();
  });

  it("a vacuous proof does not count as one", () => {
    const assertions: Assertion[] = [
      { kind: "request-status", urlIncludes: "shop.co/api/boot", status: 200, vacuous: true },
    ];
    expect(findUnprovenAction(evWith([rootDelete]), assertions)).toEqual(rootDelete);
  });

  it("stays quiet when the mutation has a checkable URL — that is just a missing proposal", () => {
    const ok = { method: "POST", url: "https://shop.co/api/orders/586738", status: 200 };
    expect(findUnprovenAction(evWith([ok]), navigated)).toBeUndefined();
  });

  it("flags an id-first URL even when a later segment names something", () => {
    // The gate asks exactly what grounding asks when it refuses a check. Anything else leaves the
    // gap between the two answers passing silently — /586738/confirm gets no check AND no gate.
    const midway = { method: "POST", url: "https://api.shop.co/586738/confirm", status: 200 };
    expect(findUnprovenAction(evWith([midway]), navigated)).toEqual(midway);
  });

  it("ignores a third-party beacon — cross-site traffic never proves the app's action", () => {
    // Amplitude posts to /2/httpapi on every route change; its first segment is a bare number, so
    // it reads exactly like an unprovable action. It is not the app's, so it cannot be one.
    const amplitude = { method: "POST", url: "https://api2.amplitude.com/2/httpapi", status: 200 };
    expect(findUnprovenAction(evWith([amplitude]), navigated)).toBeUndefined();
  });

  it("a ccTLD app still gets the filter — the site is the visited host and its subdomains, no suffix list", () => {
    const other = { method: "POST", url: "https://other.co.kr/586738", status: 200 };
    const own = { method: "POST", url: "https://api.shop.co.kr/586738", status: 200 };
    const at = (finalUrl: string, requests: Evidence["logic"]["requests"]): Evidence => ({
      ...evWith(requests),
      execution: { actions: [], navigated: true, finalUrl, blocked: false },
    });
    expect(findUnprovenAction(at("https://shop.co.kr/cart", [other]), navigated)).toBeUndefined();
    expect(findUnprovenAction(at("https://shop.co.kr/cart", [own]), navigated)).toEqual(own);
    // `www.` is a page's host, not a site boundary.
    expect(findUnprovenAction(at("https://www.shop.co.kr/cart", [own]), navigated)).toEqual(own);
  });

  it("counts a page the flow visited along the way as the app's site", () => {
    const onAuthHost = { method: "POST", url: "https://id.example.org/586738", status: 200 };
    expect(findUnprovenAction(evWith([onAuthHost]), navigated)).toBeUndefined();
    expect(
      findUnprovenAction(evWith([onAuthHost]), navigated, { pageUrls: ["https://example.org/login", undefined] }),
    ).toEqual(onAuthHost);
  });

  it("…which still arms it on same-site transport traffic — the cost, paid down with `benign`", () => {
    // A SockJS session mounts under a run-minted first segment and reads like an unprovable action.
    // Loud and fixable from outside: the product marks the endpoint, the seam meant for app noise.
    const sockjs = { method: "POST", url: "https://sockjs.shop.co/123/abc/xhr_send", status: 200 };
    expect(findUnprovenAction(evWith([sockjs]), navigated)).toEqual(sockjs);
    expect(findUnprovenAction(evWith([sockjs]), navigated, { benign: ["sockjs.shop.co"] })).toBeUndefined();
  });

  it("ignores what the entry page fired — only the flow's own traffic counts", () => {
    const pageview = { method: "POST", url: "https://shop.co/586738", status: 204 };
    const flowRequest = { method: "GET", url: "https://shop.co/api/search", status: 200 };
    expect(
      findUnprovenAction(evWith([pageview, flowRequest]), [{ kind: "navigated" }], { sinceRequest: 1 }),
    ).toBeUndefined();
  });

  it("ignores a benign root beacon and a failed mutation", () => {
    const beacon = { method: "POST", url: "https://shop.co/", status: 204 };
    expect(findUnprovenAction(evWith([beacon]), [{ kind: "navigated" }], { benign: ["shop.co/"] })).toBeUndefined();
    expect(findUnprovenAction(evWith([{ ...rootDelete, status: 500 }]), [{ kind: "navigated" }])).toBeUndefined();
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
    const opts = { wildcards: true };
    expect(urlReached("https://shop.co/orders/586738/done", to!, opts)).toBe(true);
    expect(urlReached("https://shop.co/orders/999001/done", to!, opts)).toBe(true);
    // and it still catches landing somewhere else
    expect(urlReached("https://shop.co/orders/999001/cancel", to!, opts)).toBe(false);
  });

  it("a destination with no run-minted segment freezes exactly as before", () => {
    const out = deriveAssertions([], ranTo("https://shop.co/checkout/complete"), false);
    expect(out).toContainEqual({ kind: "navigated", to: "shop.co/checkout/complete", origin: "derived" });
  });
});

describe("a destination that names no page degrades to bare navigated (#182 review)", () => {
  const ranTo = (finalUrl: string): Evidence => ({
    execution: { actions: [], navigated: true, finalUrl, blocked: false },
    perception: {},
    logic: { requests: [], console: [] },
  });

  it("an app whose first path segment is the id freezes no destination, and the leftover proves nothing", () => {
    // shop.co/* is reached by the error page and the login redirect too — exactly what this
    // assertion exists to catch — so the bare form is the honest freeze. It carries `vacuous` so
    // the all-vacuous gate still counts it as the non-check it is: without the stamp, degrading
    // would turn a scenario that failed closed into a green one (#137).
    const out = deriveAssertions([], ranTo("https://shop.co/586738"), false);
    expect(out).toContainEqual({
      kind: "navigated",
      vacuous: true,
      vacuousBecause: "no-destination",
      origin: "derived",
    });
    expect(out.some((a) => a.kind === "navigated" && a.to !== undefined)).toBe(false);
  });

  it("a wildcard leaf is not a page either — the mount prefix does not save it", () => {
    // shop.co/orders/* is reached by /orders/login and /orders/error in an app that routes them
    // under the prefix, and one URL cannot tell us whether this app does.
    const out = deriveAssertions([], ranTo("https://shop.co/orders/586738"), false);
    expect(out.some((a) => a.kind === "navigated" && a.to !== undefined)).toBe(false);
  });

  it("a literal leaf keeps the destination", () => {
    const out = deriveAssertions([], ranTo("https://shop.co/orders/586738/done"), false);
    expect(out).toContainEqual({ kind: "navigated", to: "shop.co/orders/*/done", origin: "derived" });
  });
});


describe("generalizing a destination also widens vacuity (#137 interaction)", () => {
  it("entering on one detail page and landing on another is now marked vacuous", () => {
    // The frozen check `shop.co/p/*` cannot tell the two apart, so the starting state already
    // satisfies it — which is the honest reading, and (with the guards) fails the scenario closed.
    const grounded = deriveAssertions(
      [],
      {
        execution: { actions: [], navigated: true, finalUrl: "https://shop.co/p/586738", blocked: false },
        perception: {},
        logic: { requests: [], console: [] },
      },
      false,
    );
    const baseline: Evidence = {
      execution: { actions: [], navigated: false, finalUrl: "https://shop.co/p/999001", blocked: false },
      perception: {},
      logic: { requests: [], console: [] },
    };
    expect(markVacuous(grounded, baseline).find((a) => a.kind === "navigated")?.vacuous).toBe(true);
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

  it("a same-prefix variant of the op does not ground the check (#200) — grounding, not just replay, must refuse it", () => {
    const drops: string[] = [];
    const out = deriveAssertions(
      [{ kind: "request-status", urlIncludes: "shop.co/graphql?op=AddToCart", status: 200 }],
      {
        execution: { actions: [], navigated: false, finalUrl: "https://shop.co/cart", blocked: false },
        perception: {},
        // Only a DIFFERENT operation fired (AddToCartV2) — grounding a substring match here would
        // silently freeze the check onto the wrong action's request.
        logic: {
          requests: [{ method: "POST", url: "https://shop.co/graphql?op=AddToCartV2", status: 200 }],
          console: [],
        },
      },
      false,
      [],
      (_a, r) => drops.push(r),
    );
    expect(out.some((a) => a.kind === "request-status")).toBe(false);
    expect(drops[0]).toMatch(/no captured request matched/);
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

describe("vacuity is judged with the consumer's locale list (#182 review)", () => {
  const at = (finalUrl: string): Evidence => ({
    execution: { actions: [], navigated: false, finalUrl, blocked: false },
    perception: {},
    logic: { requests: [], console: [] },
  });

  it("an injected prefix makes the entry page's own destination vacuous", () => {
    // Without the list, `fr` is not a locale to the engine, so a check the untouched entry page
    // already satisfies would look discriminating.
    const marked = markVacuous([{ kind: "navigated", to: "shop.co/en/cart" }], at("https://shop.co/fr/cart"), [], {
      localePrefixes: ["fr", "en"],
    });
    expect(marked[0]?.vacuous).toBe(true);
  });

  it("and without it the same pair is not vacuous", () => {
    const marked = markVacuous([{ kind: "navigated", to: "shop.co/en/cart" }], at("https://shop.co/fr/cart"));
    expect(marked[0]?.vacuous).toBeUndefined();
  });
});

import { proposeAssertions } from "../../../src/core/discover/grounding.js";
import type { LlmClient } from "../../../src/core/ports.js";
import type { NetworkRequest } from "../../../src/core/types.js";

// Consolidated audit coverage.

{

  // grounding-drop-reasons.test.ts
  {
    const clean: Evidence = {
      execution: { actions: [], navigated: true, finalUrl: "https://shop/products", blocked: false },
      perception: {},
      logic: { requests: [], console: [] },
    };

    function drops(proposed: unknown[], evidence: Evidence, semantic: boolean): string[] {
      const out: string[] = [];
      deriveAssertions(proposed as Assertion[], evidence, semantic, [], (_a, reason) => out.push(reason));
      return out;
    }

    describe("deriveAssertions names why each proposal was dropped", () => {
      it("groundingDropReasons: expect is dropped as 'semantic checks are off' or 'empty criterion'", () => {
        expect(drops([{ kind: "expect", criterion: "cart shows the item" }], clean, false)).toEqual([
          "semantic checks are off — expect needs an LlmCritic at replay",
        ]);
        expect(drops([{ kind: "expect", criterion: "   " }], clean, true)).toEqual(["malformed proposal (empty criterion)"]);
        expect(drops([{ kind: "expect" }], clean, true)).toEqual(["malformed proposal (empty criterion)"]);
      });

      it("groundingDropReasons: a null entry is skipped silently, a kind-less object is reported", () => {
        expect(drops([null, undefined, { urlIncludes: "/x" }, { kind: 7 }], clean, false)).toEqual([
          "malformed proposal (no kind)",
          "malformed proposal (no kind)",
        ]);
      });

      it("groundingDropReasons: an unknown kind is named in the reason", () => {
        expect(drops([{ kind: "screenshot-matches" }], clean, false)).toEqual(['unknown proposed kind "screenshot-matches"']);
      });

      it("groundingDropReasons: a default that did not hold is reported with the exact wording", () => {
        const dirty: Evidence = {
          execution: { actions: [], navigated: false, finalUrl: "https://shop/", blocked: false },
          perception: {},
          logic: {
            requests: [{ method: "GET", url: "https://shop/api/x", status: 500 }],
            console: [{ type: "error", text: "boom" }],
          },
        };
        expect(
          drops([{ kind: "no-failed-requests" }, { kind: "no-console-errors" }, { kind: "navigated" }], dirty, false),
        ).toEqual([
          "no-failed-requests did not hold during discovery",
          "no-console-errors did not hold during discovery",
          "the run did not navigate",
        ]);
      });

      it("groundingDropReasons: a default that held is not reported at all", () => {
        expect(drops([{ kind: "no-failed-requests" }, { kind: "no-console-errors" }, { kind: "navigated" }], clean, false)).toEqual([]);
      });
    });
  }

  // grounding-propose-tolerates.test.ts
  {
    const evidence: Evidence = {
      execution: { actions: [], navigated: true, finalUrl: "https://shop/done", blocked: false },
      perception: {},
      logic: { requests: [{ method: "POST", url: "https://shop/api/order", status: 201 }], console: [] },
    };

    class RecordingLlm implements LlmClient {
      readonly id = "recording";
      prompt = "";
      system: string | undefined;
      constructor(private readonly reply: () => string) {}
      async complete(prompt: string, opts?: { system?: string }): Promise<string> {
        this.prompt = prompt;
        this.system = opts?.system;
        return this.reply();
      }
    }

    describe("proposeAssertions never lets the model break the freeze", () => {
      it("proposeAssertionsTolerates: an LLM that throws proposes nothing", async () => {
        const llm = new RecordingLlm(() => {
          throw new Error("rate limited");
        });
        await expect(proposeAssertions(llm, "buy", evidence, false)).resolves.toEqual([]);
      });

      it("proposeAssertionsTolerates: a reply with no JSON array proposes nothing", async () => {
        expect(await proposeAssertions(new RecordingLlm(() => '{"kind":"navigated"}'), "buy", evidence, false)).toEqual([]);
        expect(await proposeAssertions(new RecordingLlm(() => "no assertions needed"), "buy", evidence, false)).toEqual([]);
      });

      it("proposeAssertionsTolerates: a fenced array still comes through", async () => {
        const llm = new RecordingLlm(() => '```json\n[{"kind":"navigated","to":"shop/done"}]\n```');
        expect(await proposeAssertions(llm, "buy", evidence, false)).toEqual([{ kind: "navigated", to: "shop/done" }]);
      });

      it("proposeAssertionsSemanticSuffix: the system prompt offers `expect` only when semantic checks are on", async () => {
        const off = new RecordingLlm(() => "[]");
        await proposeAssertions(off, "buy", evidence, false);
        expect(off.system).not.toContain('"kind":"expect"');
        const on = new RecordingLlm(() => "[]");
        await proposeAssertions(on, "buy", evidence, true);
        expect(on.system).toContain('"kind":"expect"');
        expect(on.system!.startsWith(off.system!)).toBe(true);
      });
    });
  }

  // grounding-render-evidence.test.ts
  {
    class RecordingLlm implements LlmClient {
      readonly id = "recording";
      prompt = "";
      async complete(prompt: string): Promise<string> {
        this.prompt = prompt;
        return "[]";
      }
    }

    function withRequests(requests: NetworkRequest[]): Evidence {
      return {
        execution: { actions: [], navigated: false, finalUrl: "https://shop/", blocked: false },
        perception: {},
        logic: { requests, console: [{ type: "error", text: "boom" }, { type: "log", text: "fine" }] },
      };
    }

    describe("the evidence the assertion prompt shows the model", () => {
      it("renderEvidenceCapsRequests: the request listing stops at 40 lines but still states the real count", async () => {
        const requests = Array.from({ length: 45 }, (_, i) => ({ method: "GET", url: `https://shop/asset/${i}`, status: 200 }));
        const llm = new RecordingLlm();
        await proposeAssertions(llm, "browse", withRequests(requests), false);
        expect(llm.prompt).toContain("all requests (45):");
        expect(llm.prompt).toContain("200 GET https://shop/asset/39");
        expect(llm.prompt).not.toContain("https://shop/asset/40");
      });

      it("renderEvidenceMutationsBlock: settled successful mutations are listed apart, in-flight and failed ones are not", async () => {
        const llm = new RecordingLlm();
        await proposeAssertions(
          llm,
          "buy",
          withRequests([
            { method: "GET", url: "https://shop/api/products", status: 200 },
            { method: "POST", url: "https://shop/api/cart", status: 201 },
            { method: "POST", url: "https://shop/api/pending", status: 0 },
            { method: "POST", url: "https://shop/api/failed", status: 500 },
          ]),
          false,
        );
        const [, mutationsBlock = ""] = llm.prompt.split("state-changing requests that prove an action (prefer one of these): ");
        const [mutations = ""] = mutationsBlock.split("all requests");
        expect(mutations.trim().split("\n")).toEqual(["201 POST https://shop/api/cart"]);
        expect(llm.prompt).toContain("finalUrl: https://shop/ (navigated: false)");
        expect(llm.prompt).toContain("console errors (1): boom");
      });

      it("renderEvidenceEmpty: with nothing captured every block says (none)", async () => {
        const llm = new RecordingLlm();
        await proposeAssertions(
          llm,
          "browse",
          { execution: { actions: [], navigated: false, blocked: false }, perception: {}, logic: { requests: [], console: [] } },
          false,
        );
        expect(llm.prompt).toContain("finalUrl: (none) (navigated: false)");
        expect(llm.prompt).toContain("prefer one of these): (none)");
        expect(llm.prompt).toContain("all requests (0):\n(none)");
        expect(llm.prompt).toContain("console errors (0): (none)");
      });
    });
  }

}
