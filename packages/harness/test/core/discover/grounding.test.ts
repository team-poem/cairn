import { describe, expect, it } from "vitest";
import { deriveAssertions } from "../../../src/core/discover/grounding.js";
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
