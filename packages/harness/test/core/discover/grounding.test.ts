import { describe, expect, it } from "vitest";
import { deriveAssertions, markVacuous } from "../../../src/core/discover/grounding.js";
import type { Evidence } from "../../../src/core/types.js";

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
