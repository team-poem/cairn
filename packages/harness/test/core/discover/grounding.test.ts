import { describe, expect, it } from "vitest";
import { deriveAssertions, markVacuous } from "../../../src/core/discover/grounding.js";
import type { Evidence } from "../../../src/core/types.js";
import { findRequestStatus } from "../../../src/core/requests.js";
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

  it("an id before the verb merges two different actions into one check", () => {
    // /api/orders/{id}/confirm and /api/orders/{id}/cancel both cut to host/api/orders, so the
    // frozen check no longer distinguishes them: a scenario proving a confirm passes on a cancel.
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
    );
    expect(out.filter((a) => a.kind === "request-status")).toEqual([
      { kind: "request-status", urlIncludes: "shop.co/api/orders", status: 200, method: "POST", origin: "derived" },
    ]);
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
    expect(drops[0]).toMatch(/not a settled outcome/);
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
