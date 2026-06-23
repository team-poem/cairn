import { describe, expect, it } from "vitest";
import { checkAssertion } from "./assertion.js";
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
