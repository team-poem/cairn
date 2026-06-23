import { describe, expect, it } from "vitest";
import { checkAssertion, AssertionCritic } from "./assertion.js";
import type { Evidence } from "../../core/types.js";

function ev(requests: { method: string; url: string; status: number }[]): Evidence {
  return {
    execution: { actions: [], navigated: true, finalUrl: "https://x", blocked: false },
    perception: {},
    logic: { requests, console: [] },
  };
}

describe("no-failed-requests", () => {
  it("ignores a benign favicon 404 (would otherwise fail a real test)", () => {
    const r = checkAssertion({ kind: "no-failed-requests" }, ev([
      { method: "GET", url: "https://todomvc.com/favicon.ico", status: 404 },
    ]));
    expect(r.passed).toBe(true);
  });
  it("still fails on a real failed request", () => {
    const r = checkAssertion({ kind: "no-failed-requests" }, ev([
      { method: "GET", url: "https://app/api/orders", status: 500 },
    ]));
    expect(r.passed).toBe(false);
  });
});

describe("custom assertions — the host defines success", () => {
  it("runs a product-registered check", async () => {
    const critic = new AssertionCritic({
      "ordered-via": (params, evidence) =>
        evidence.logic.requests.some((r) => r.url.includes(String(params.path)) && r.status === 200),
    });
    const evidence = ev([{ method: "POST", url: "https://shop/api/checkout", status: 200 }]);
    const v = await critic.judge(evidence, [{ kind: "custom", name: "ordered-via", params: { path: "/api/checkout" } }]);
    expect(v.passed).toBe(true);
  });

  it("fails clearly when no handler is registered", async () => {
    const v = await new AssertionCritic().judge(ev([]), [{ kind: "custom", name: "unknown" }]);
    expect(v.passed).toBe(false);
    expect(v.results[0]?.detail).toContain("no custom check registered");
  });
});
