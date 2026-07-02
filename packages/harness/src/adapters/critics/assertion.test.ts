import { describe, expect, it } from "vitest";
import {
  checkAssertion,
  AssertionCritic,
  MechanicalAssertionHandler,
  CustomAssertionHandler,
  judgeAssertion,
} from "./assertion.js";
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
  it("treats product-marked URLs as benign noise (P7)", () => {
    const requests = [{ method: "GET", url: "https://analytics.x/track", status: 404 }];
    expect(checkAssertion({ kind: "no-failed-requests" }, ev(requests)).passed).toBe(false);
    expect(checkAssertion({ kind: "no-failed-requests" }, ev(requests), ["analytics.x"]).passed).toBe(true);
  });
});

describe("no-failed-requests — a retried endpoint that recovered is benign (#66)", () => {
  it("passes when the same endpoint (method + path, query ignored) later succeeds", () => {
    const r = checkAssertion({ kind: "no-failed-requests" }, ev([
      { method: "POST", url: "https://app/api/auth?attempt=1", status: 401 },
      { method: "POST", url: "https://app/api/auth?attempt=2", status: 200 },
    ]));
    expect(r.passed).toBe(true);
  });

  it("still fails when the endpoint never recovers", () => {
    const r = checkAssertion({ kind: "no-failed-requests" }, ev([
      { method: "POST", url: "https://app/api/auth", status: 401 },
      { method: "GET", url: "https://app/api/items", status: 200 },
    ]));
    expect(r.passed).toBe(false);
  });

  it("a successful GET does not mask a failed POST to the same path", () => {
    const r = checkAssertion({ kind: "no-failed-requests" }, ev([
      { method: "POST", url: "https://app/api/order", status: 500 },
      { method: "GET", url: "https://app/api/order", status: 200 },
    ]));
    expect(r.passed).toBe(false);
  });

  it("a success BEFORE the failure does not count as recovery", () => {
    const r = checkAssertion({ kind: "no-failed-requests" }, ev([
      { method: "GET", url: "https://app/api/me", status: 200 },
      { method: "GET", url: "https://app/api/me", status: 500 },
    ]));
    expect(r.passed).toBe(false);
  });
});

describe("no-console-errors — product-marked noise is benign (#66)", () => {
  const withConsole = (text: string): Evidence => ({
    execution: { actions: [], navigated: true, finalUrl: "https://x", blocked: false },
    perception: {},
    logic: { requests: [], console: [{ type: "error", text }] },
  });

  it("ignores configured benign patterns", () => {
    const e = withConsole("Missing translation for key checkout.title");
    expect(checkAssertion({ kind: "no-console-errors" }, e, [], ["Missing translation"]).passed).toBe(true);
  });

  it("still fails on unmarked console errors", () => {
    const e = withConsole("TypeError: cart is undefined");
    expect(checkAssertion({ kind: "no-console-errors" }, e, [], ["Missing translation"]).passed).toBe(false);
  });
});

describe("navigated — path boundary, not raw substring", () => {
  const at = (finalUrl: string): Evidence => ({
    execution: { actions: [], navigated: true, finalUrl, blocked: false },
    perception: {},
    logic: { requests: [], console: [] },
  });
  it("passes when the destination is reached", () => {
    expect(checkAssertion({ kind: "navigated", to: "x.co/en/cart" }, at("https://x.co/en/cart?q=1")).passed).toBe(true);
  });
  it("does NOT false-pass on a parent path (…/en must not match …/en/signin)", () => {
    expect(checkAssertion({ kind: "navigated", to: "x.co/en" }, at("https://x.co/en/signin")).passed).toBe(false);
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

describe("assertion handler chain — critics differ only by handler set", () => {
  const evidence = ev([{ method: "GET", url: "https://x", status: 200 }]);

  it("MechanicalAssertionHandler supports everything except custom", () => {
    const h = new MechanicalAssertionHandler();
    expect(h.supports({ kind: "navigated" })).toBe(true);
    expect(h.supports({ kind: "expect", criterion: "x" })).toBe(true);
    expect(h.supports({ kind: "custom", name: "c" })).toBe(false);
  });

  it("CustomAssertionHandler supports only custom and runs the registry", async () => {
    const h = new CustomAssertionHandler({ ok: () => true });
    expect(h.supports({ kind: "custom", name: "ok" })).toBe(true);
    expect(h.supports({ kind: "navigated" })).toBe(false);
    const r = await h.judge({ kind: "custom", name: "ok" }, evidence);
    expect(r.passed).toBe(true);
  });

  it("the deterministic chain routes `expect` to the mechanical LlmCritic hint (no LLM handler present)", async () => {
    const chain = [new MechanicalAssertionHandler(), new CustomAssertionHandler()];
    const r = await judgeAssertion(chain, { kind: "expect", criterion: "x" }, evidence);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("LlmCritic"); // adding ExpectAssertionHandler (as LlmCritic does) overrides this
  });
});
