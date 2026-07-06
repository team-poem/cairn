import { describe, expect, it } from "vitest";
import {
  checkAssertion,
  AssertionCritic,
  MechanicalAssertionHandler,
  CustomAssertionHandler,
  judgeAssertion,
} from "../../../src/adapters/critics/assertion.js";
import type { Evidence } from "../../../src/core/types.js";

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

  it("an in-flight retry (status 0) does not count as recovery (#97)", () => {
    const r = checkAssertion({ kind: "no-failed-requests" }, ev([
      { method: "POST", url: "https://app/api/auth", status: 401 },
      { method: "POST", url: "https://app/api/auth", status: 0 },
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

describe("navigated — respects the same localePrefixes injection as expect matching (#86 follow-up)", () => {
  const at = (finalUrl: string): Evidence => ({
    execution: { actions: [], navigated: true, finalUrl, blocked: false },
    perception: {},
    logic: { requests: [], console: [] },
  });
  it("checkAssertion: a consumer-declared locale (\"xx\") only matches when injected", () => {
    const assertion = { kind: "navigated" as const, to: "app.co/en/cart" };
    expect(checkAssertion(assertion, at("https://app.co/xx/cart")).passed).toBe(false);
    expect(checkAssertion(assertion, at("https://app.co/xx/cart"), [], [], ["en", "xx"]).passed).toBe(true);
  });
  it("AssertionCritic threads localePrefixes into its navigated verdict, not just step expects", async () => {
    const withInjection = new AssertionCritic(undefined, undefined, undefined, ["en", "xx"]);
    const v1 = await withInjection.judge(at("https://app.co/xx/cart"), [{ kind: "navigated", to: "app.co/en/cart" }]);
    expect(v1.passed).toBe(true);

    const withoutInjection = new AssertionCritic();
    const v2 = await withoutInjection.judge(at("https://app.co/xx/cart"), [{ kind: "navigated", to: "app.co/en/cart" }]);
    expect(v2.passed).toBe(false); // "xx" is a real route under the default list — must not silently match
  });
});

describe("empty assertion set — fail closed, not vacuously green (#69)", () => {
  it("a scenario with zero assertions does not pass", async () => {
    const v = await new AssertionCritic().judge(ev([]), []);
    expect(v.passed).toBe(false);
    expect(v.detail).toContain("no assertions");
  });

  it("a scenario with assertions is unaffected", async () => {
    const v = await new AssertionCritic().judge(ev([]), [{ kind: "navigated" }]);
    expect(v.passed).toBe(true);
    expect(v.detail).toBeUndefined();
  });
});

describe("request-status — any matching request, not the first (#68)", () => {
  it("passes when an earlier request to the same endpoint failed (401 retried to 200)", () => {
    const r = checkAssertion({ kind: "request-status", urlIncludes: "/api/auth", status: 200 }, ev([
      { method: "POST", url: "https://app/api/auth", status: 401 },
      { method: "POST", url: "https://app/api/auth", status: 200 },
    ]));
    expect(r.passed).toBe(true);
    expect(r.detail).toContain("200");
  });

  it("keeps single-response behavior unchanged", () => {
    const hit = ev([{ method: "GET", url: "https://app/api/me", status: 200 }]);
    expect(checkAssertion({ kind: "request-status", urlIncludes: "/api/me", status: 200 }, hit).passed).toBe(true);
    expect(checkAssertion({ kind: "request-status", urlIncludes: "/api/me", status: 204 }, hit).passed).toBe(false);
  });

  it("fails with every observed status when none matches", () => {
    const r = checkAssertion({ kind: "request-status", urlIncludes: "/api/auth", status: 200 }, ev([
      { method: "POST", url: "https://app/api/auth", status: 401 },
      { method: "POST", url: "https://app/api/auth", status: 500 },
    ]));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("401, 500");
  });

  it("still reports a missing endpoint distinctly", () => {
    const r = checkAssertion({ kind: "request-status", urlIncludes: "/api/orders", status: 200 }, ev([]));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("no request matching");
  });
});

describe("request-status — optional method scoping, parity with the step-level expect (#94)", () => {
  // A duplicate-application flow: a GET sharing the URL prefix answers 200, the real POST answers 409.
  const dup = ev([
    { method: "GET", url: "https://app/api/applications?postId=p1", status: 200 },
    { method: "POST", url: "https://app/api/applications", status: 409 },
  ]);

  it("a same-prefix GET does not decide — the later 409 POST satisfies the assertion", () => {
    const r = checkAssertion({ kind: "request-status", urlIncludes: "/api/applications", status: 409 }, dup);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain("409");
  });

  it("scopes to the method when given", () => {
    const r = checkAssertion(
      { kind: "request-status", urlIncludes: "/api/applications", status: 409, method: "POST" },
      dup,
    );
    expect(r.passed).toBe(true);
  });

  it("a same-prefix GET cannot satisfy a POST check even on status collision", () => {
    const collision = ev([{ method: "GET", url: "https://app/api/applications", status: 200 }]);
    const r = checkAssertion(
      { kind: "request-status", urlIncludes: "/api/applications", status: 200, method: "POST" },
      collision,
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("no POST request matching");
  });

  it("matches the method case-insensitively", () => {
    const r = checkAssertion(
      { kind: "request-status", urlIncludes: "/api/applications", status: 409, method: "post" },
      dup,
    );
    expect(r.passed).toBe(true);
  });

  it("failure detail lists only same-method statuses when method is given", () => {
    const r = checkAssertion(
      { kind: "request-status", urlIncludes: "/api/applications", status: 201, method: "POST" },
      dup,
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("409");
    expect(r.detail).not.toContain("200");
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
