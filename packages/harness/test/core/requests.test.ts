import { describe, expect, it } from "vitest";
import {
  findRequestStatus,
  isBenignRequest,
  isMutation,
  isRecoveredFailure,
  urlMatchesFrozen,
} from "../../src/core/requests.js";
import type { NetworkRequest } from "../../src/core/types.js";

const req = (method: string, url: string, status: number): NetworkRequest => ({ method, url, status });

describe("findRequestStatus — url AND status (AND method when given)", () => {
  it("matches on url substring + status", () => {
    const hit = findRequestStatus([req("GET", "https://app/api/me", 200)], "/api/me", 200);
    expect(hit?.status).toBe(200);
  });

  it("a 401 → retry → 200 sequence satisfies a 200 check (any match, not the first)", () => {
    const log = [req("POST", "https://app/api/auth", 401), req("POST", "https://app/api/auth", 200)];
    expect(findRequestStatus(log, "/api/auth", 200)?.status).toBe(200);
  });

  it("method scopes the match: a same-prefix GET does not satisfy a POST check", () => {
    const log = [req("GET", "https://app/api/orders?page=1", 200)];
    expect(findRequestStatus(log, "/api/orders", 200, "POST")).toBeUndefined();
    expect(findRequestStatus(log, "/api/orders", 200, "GET")?.method).toBe("GET");
  });

  it("method is case-insensitive and optional", () => {
    const log = [req("post", "https://app/api/orders", 201)];
    expect(findRequestStatus(log, "/api/orders", 201, "POST")).toBeDefined();
    expect(findRequestStatus(log, "/api/orders", 201)).toBeDefined();
  });

  it("returns undefined when url or status never match", () => {
    const log = [req("GET", "https://app/api/me", 200)];
    expect(findRequestStatus(log, "/api/other", 200)).toBeUndefined();
    expect(findRequestStatus(log, "/api/me", 204)).toBeUndefined();
  });
});

describe("urlMatchesFrozen (#200) — the part before '?' is a substring, the part after is a query subset", () => {
  it("plain substring, no query — same as today", () => {
    expect(urlMatchesFrozen("https://app/api/me?x=1", "/api/me")).toBe(true);
    expect(urlMatchesFrozen("https://app/api/other", "/api/me")).toBe(false);
  });

  it("a longer operation value does NOT satisfy a shorter frozen one (GraphQL op versioning)", () => {
    expect(urlMatchesFrozen("https://shop.co/graphql?op=AddToCartV2", "shop.co/graphql?op=AddToCart")).toBe(false);
    expect(urlMatchesFrozen("https://shop.co/graphql?op=AddToCartAsync", "shop.co/graphql?op=AddToCart")).toBe(
      false,
    );
  });

  it("the exact frozen op still matches", () => {
    expect(urlMatchesFrozen("https://shop.co/graphql?op=AddToCart", "shop.co/graphql?op=AddToCart")).toBe(true);
  });

  it("extra params on the actual URL are tolerated (a leading trace param)", () => {
    expect(urlMatchesFrozen("https://shop.co/graphql?trace=xy&op=AddToCart", "shop.co/graphql?op=AddToCart")).toBe(
      true,
    );
  });

  it("param order does not matter", () => {
    expect(
      urlMatchesFrozen("https://shop.co/api?mode=express&action=checkout", "shop.co/api?action=checkout&mode=express"),
    ).toBe(true);
  });

  it("a missing frozen param fails the match", () => {
    expect(urlMatchesFrozen("https://shop.co/api?action=checkout", "shop.co/api?action=checkout&mode=express")).toBe(
      false,
    );
  });
});

describe("findRequestStatus routes query matching through urlMatchesFrozen (#200)", () => {
  it("a same-prefix operation on the same endpoint does not satisfy the frozen check", () => {
    const log = [req("POST", "https://shop.co/graphql?op=AddToCartV2", 200)];
    expect(findRequestStatus(log, "shop.co/graphql?op=AddToCart", 200)).toBeUndefined();
  });

  it("reordered/extra query params still satisfy a frozen subset", () => {
    const log = [req("POST", "https://shop.co/api?trace=xy&mode=express&action=checkout", 200)];
    expect(findRequestStatus(log, "shop.co/api?action=checkout", 200)).toBeDefined();
  });
});

describe("isBenignRequest — universal noise + product list", () => {
  it("treats favicon and robots as noise (query allowed)", () => {
    expect(isBenignRequest("https://app/favicon.ico")).toBe(true);
    expect(isBenignRequest("https://app/favicon.ico?v=2")).toBe(true);
    expect(isBenignRequest("https://app/robots.txt")).toBe(true);
  });
  it("honors a product benign list by substring, and nothing else", () => {
    expect(isBenignRequest("https://analytics.x/track", ["analytics.x"])).toBe(true);
    expect(isBenignRequest("https://app/api/orders", ["analytics.x"])).toBe(false);
  });
});

describe("isRecoveredFailure — same endpoint (method + host/path) later succeeded", () => {
  it("a failure followed by a success on the same endpoint is recovered", () => {
    const log = [req("POST", "https://app/api/auth", 401), req("POST", "https://app/api/auth", 200)];
    expect(isRecoveredFailure(log, 0)).toBe(true);
  });
  it("query differences don't break endpoint identity", () => {
    const log = [req("POST", "https://app/api/auth?attempt=1", 401), req("POST", "https://app/api/auth?attempt=2", 200)];
    expect(isRecoveredFailure(log, 0)).toBe(true);
  });
  it("a different method is a different endpoint — GET can't mask a failed POST", () => {
    const log = [req("POST", "https://app/api/order", 500), req("GET", "https://app/api/order", 200)];
    expect(isRecoveredFailure(log, 0)).toBe(false);
  });
  it("a success BEFORE the failure is not a recovery", () => {
    const log = [req("GET", "https://app/api/me", 200), req("GET", "https://app/api/me", 500)];
    expect(isRecoveredFailure(log, 1)).toBe(false);
  });
  it("an in-flight retry (status 0) is not a recovery", () => {
    const log = [req("POST", "https://app/api/auth", 401), req("POST", "https://app/api/auth", 0)];
    expect(isRecoveredFailure(log, 0)).toBe(false);
  });
  it("a non-failure index is never 'recovered'", () => {
    expect(isRecoveredFailure([req("GET", "https://app/x", 200)], 0)).toBe(false);
    expect(isRecoveredFailure([], 3)).toBe(false);
  });
});

describe("isMutation — the methods that prove an action happened", () => {
  it("POST/PUT/PATCH/DELETE are mutations, case-insensitive", () => {
    for (const m of ["POST", "put", "Patch", "DELETE"]) expect(isMutation(m)).toBe(true);
  });
  it("GET/HEAD/OPTIONS are reads", () => {
    for (const m of ["GET", "head", "OPTIONS"]) expect(isMutation(m)).toBe(false);
  });
});

import { onSiteOf } from "../../src/core/requests.js";

// Consolidated audit coverage.

{

  // requests-on-site-of-host-boundaries.test.ts
  {
    it("onSiteOfHostBoundaries: same host or a subdomain is on-site, www. on the page is not a boundary, and an unparseable URL on either side never matches", () => {
      expect(onSiteOf("https://shop.co/cart", "https://api.shop.co/orders")).toBe(true);
      expect(onSiteOf("https://www.shop.co/cart", "https://shop.co/orders")).toBe(true);
      expect(onSiteOf("https://shop.co/cart", "https://api2.amplitude.com/x")).toBe(false);
      expect(onSiteOf("https://shop.co.kr/", "https://other.co.kr/")).toBe(false); // not under each other
      expect(onSiteOf("https://shop.co/", "https://evilshop.co/")).toBe(false); // suffix without a dot boundary
      expect(onSiteOf("not a url", "https://shop.co/")).toBe(false);
      expect(onSiteOf("https://shop.co/", "/relative/path")).toBe(false);
      expect(onSiteOf("", "")).toBe(false);
    });
  }

}
