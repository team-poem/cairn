import { describe, expect, it } from "vitest";
import {
  BuiltinStepHandler,
  CustomStepHandler,
  defaultStepHandlers,
  urlReached,
} from "../../src/core/steps.js";
import { FakeDriver } from "../../src/adapters/drivers/fake.js";
import { URL_REACHED_CORPUS, URL_REACHED_WILDCARD_CORPUS } from "../support/url-corpus.js";
import type { Evidence, Step } from "../../src/core/types.js";
import { conditionMet } from "../../src/core/steps.js";
import { vi } from "vitest";
import { StubDriver } from "../support/doubles.js";
import type { PageElement } from "../../src/core/types.js";

describe("urlReached", () => {
  it("matches an exact host+path and ignores scheme/query/hash/trailing slash", () => {
    expect(urlReached("https://x.co/en/cart?a=1#h", "x.co/en/cart")).toBe(true);
    expect(urlReached("https://x.co/en/", "x.co/en")).toBe(true);
  });

  it("matches a bare suffix at a path boundary", () => {
    expect(urlReached("https://x.co/en/cart", "cart")).toBe(true);
    expect(urlReached("https://x.co/en/cart", "/en/cart")).toBe(true);
  });

  it("does NOT treat a parent path as reaching a deeper one (the skip bug)", () => {
    expect(urlReached("https://x.co/en/signin", "x.co/en")).toBe(false);
    expect(urlReached("https://x.co/en/signin", "/en")).toBe(false);
  });

  it("ignores the locale segment so a frozen destination survives another env/locale", () => {
    expect(urlReached("https://x.co/ko/cart", "x.co/en/cart")).toBe(true);
    expect(urlReached("https://x.co/jp/payment", "x.co/en/payment")).toBe(true);
    expect(urlReached("https://x.co/ko/signin", "x.co/en/cart")).toBe(false);
  });
});

describe("urlReached — URL counter-example corpus (default options)", () => {
  for (const c of URL_REACHED_CORPUS) {
    it(`${c.note}: ${c.final} vs "${c.want}" → ${c.reached}`, () => {
      expect(urlReached(c.final, c.want)).toBe(c.reached);
    });
  }
});

describe("urlReached — wildcard segments in a frozen destination", () => {
  // `wildcards: true` is what `Scenario.wildcards` sets: this freeze wrote the notation.
  for (const c of URL_REACHED_WILDCARD_CORPUS) {
    it(`${c.note}: ${c.final} vs "${c.want}" → ${c.reached}`, () => {
      expect(urlReached(c.final, c.want, { wildcards: true })).toBe(c.reached);
    });
  }

  it("without the marker a * is the character it was frozen as", () => {
    // A skill written before the notation existed: its path really does contain a star.
    expect(urlReached("https://shop.co/search/*/results", "shop.co/search/*/results")).toBe(true);
    expect(urlReached("https://shop.co/search/shoes/results", "shop.co/search/*/results")).toBe(false);
  });
});

describe("urlReached — locale prefixes are consumer-injected, not guessed (#86)", () => {
  it("a consumer-declared locale participates in the fallback", () => {
    // "xx" is not in the engine's default list; the consumer says their app serves it as a locale.
    expect(urlReached("https://x.co/xx/cart", "x.co/en/cart", { localePrefixes: ["en", "xx"] })).toBe(true);
  });

  it("a narrowed list disables default prefixes", () => {
    expect(urlReached("https://x.co/jp/payment", "x.co/en/payment", { localePrefixes: ["en"] })).toBe(false);
  });

  it("an empty list turns the locale fallback off entirely", () => {
    expect(urlReached("https://x.co/ko/cart", "x.co/en/cart", { localePrefixes: [] })).toBe(false);
  });

  it("direct boundary match wins before any locale interpretation", () => {
    // Even with "my" declared a locale, an exact /my destination matches directly (stage 1).
    expect(urlReached("https://x.co/my", "x.co/my", { localePrefixes: ["my"] })).toBe(true);
  });
});

const EVIDENCE: Evidence = {
  execution: { actions: [], navigated: false, blocked: false },
  perception: {},
  logic: { requests: [], console: [] },
};

const driver = () => new FakeDriver({ evidence: EVIDENCE });

describe("BuiltinStepHandler", () => {
  const handler = new BuiltinStepHandler();

  it("supports every built-in kind but not custom", () => {
    expect(handler.supports({ kind: "click", target: { text: "A" } })).toBe(true);
    expect(handler.supports({ kind: "scroll" })).toBe(true);
    expect(handler.supports({ kind: "custom", name: "x" })).toBe(false);
  });

  it("routes a step to the matching driver method", async () => {
    const d = driver();
    await handler.execute({ kind: "hover", target: { text: "Menu" } }, d);
    await handler.execute({ kind: "pressKey", key: "Enter" }, d);
    expect(d.hovered).toEqual([{ text: "Menu" }]);
    expect(d.keys).toEqual(["Enter"]);
  });

  it("rejects a custom step it should never have been routed (ordering guard)", async () => {
    await expect(handler.execute({ kind: "custom", name: "wiggle" }, driver())).rejects.toThrow(/custom step/);
  });
});

describe("CustomStepHandler", () => {
  it("supports only custom steps", () => {
    const handler = new CustomStepHandler({});
    expect(handler.supports({ kind: "custom", name: "x" })).toBe(true);
    expect(handler.supports({ kind: "click", target: {} })).toBe(false);
  });

  it("invokes the registered action with its params", async () => {
    const seen: unknown[] = [];
    const handler = new CustomStepHandler({ wiggle: async (_d, p) => void seen.push(p.n) });
    await handler.execute({ kind: "custom", name: "wiggle", params: { n: 3 } }, driver());
    expect(seen).toEqual([3]);
  });

  it("throws when no action is registered for the name", async () => {
    const handler = new CustomStepHandler({});
    await expect(handler.execute({ kind: "custom", name: "missing" }, driver())).rejects.toThrow(/no handler registered/);
  });
});

describe("defaultStepHandlers", () => {
  it("routes built-ins and custom through one find(supports) chain", async () => {
    const seen: string[] = [];
    const handlers = defaultStepHandlers({ ping: async () => void seen.push("ping") });
    const d = driver();
    const run = async (step: Step) => {
      const h = handlers.find((x) => x.supports(step));
      if (!h) throw new Error(`no handler for ${step.kind}`);
      await h.execute(step, d);
    };
    await run({ kind: "click", target: { text: "Go" } });
    await run({ kind: "custom", name: "ping" });
    expect(d.clicked).toEqual([{ text: "Go" }]);
    expect(seen).toEqual(["ping"]);
  });
});

describe("waitFor step", () => {
  const handler = new BuiltinStepHandler();

  it("supports the waitFor kind", () => {
    expect(handler.supports({ kind: "waitFor", until: { url: "/x" } })).toBe(true);
  });

  it("returns once url + request + element all hold", async () => {
    const d = new FakeDriver({
      evidence: {
        execution: { actions: [], navigated: true, finalUrl: "https://x/en/cart", blocked: false },
        perception: {},
        logic: { requests: [{ method: "GET", url: "https://x/api/me", status: 200 }], console: [] },
      },
      elements: [{ role: "link", name: "Cart" }],
    });
    await handler.execute(
      {
        kind: "waitFor",
        until: { url: "/cart", requestStatus: { urlIncludes: "/api/me", status: 200 }, text: "Cart" },
      },
      d,
    );
    // no throw == condition satisfied (deterministic, no LLM)
  });

  it("throws on timeout when the condition never holds", async () => {
    const d = new FakeDriver({
      evidence: {
        execution: { actions: [], navigated: false, finalUrl: "https://x/en", blocked: false },
        perception: {},
        logic: { requests: [], console: [] },
      },
    });
    await expect(
      handler.execute({ kind: "waitFor", until: { url: "/cart" }, timeoutMs: 30 }, d),
    ).rejects.toThrow(/waitFor timed out/);
  });
});

it("conditionMetRoleOnlyRequiresElementOfRole: an until with role but no text is not vacuously true — it requires an element of that role to be present (fail closed)", async () => {
  const driver = new FakeDriver({
    evidence: {
      execution: { actions: [], navigated: false, blocked: false },
      perception: {},
      logic: { requests: [], console: [] },
    },
    elements: [{ role: "link", name: "Cart" }],
  });
  await expect(conditionMet(driver, { role: "button" })).resolves.toBe(false);
  await expect(conditionMet(driver, { role: "link" })).resolves.toBe(true);
});

describe("conditionMet audit coverage", () => {
  it("conditionMetEmptyUntilHoldsWithoutObserving: an empty condition is vacuously true and touches neither observe() nor snapshot()", async () => {
    const driver = new StubDriver();
    const observe = vi.spyOn(driver, "observe");
    const snapshot = vi.spyOn(driver, "snapshot");
    await expect(conditionMet(driver, {})).resolves.toBe(true);
    expect(observe).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("conditionMetRequestWatermarkAndMethod: sinceRequestIndex slices the cumulative log before matching, and method scopes the match", async () => {
    class LoggedRequests extends StubDriver {
      override async observe(): Promise<Evidence> {
        return {
          execution: { actions: [], navigated: true, finalUrl: this.url, blocked: false },
          perception: {},
          logic: {
            requests: [
              { method: "GET", url: "https://api.app/cart", status: 200 },
              { method: "POST", url: "https://api.app/cart", status: 201 },
            ],
            console: [],
          },
        };
      }
    }
    const driver = new LoggedRequests();
    const post = { urlIncludes: "/cart", status: 201, method: "post" };
    await expect(conditionMet(driver, { requestStatus: post }, 0)).resolves.toBe(true);
    await expect(conditionMet(driver, { requestStatus: post }, 1)).resolves.toBe(true);
    await expect(conditionMet(driver, { requestStatus: post }, 2)).resolves.toBe(false);
    await expect(
      conditionMet(driver, { requestStatus: { urlIncludes: "/cart", status: 200, method: "POST" } }),
    ).resolves.toBe(false);
  });

  it("conditionMetRequestStatusQuerySubset: waitFor.requestStatus matches the query as a subset, same as the assertion path (#200)", async () => {
    class LoggedRequests extends StubDriver {
      override async observe(): Promise<Evidence> {
        return {
          execution: { actions: [], navigated: true, finalUrl: this.url, blocked: false },
          perception: {},
          logic: {
            requests: [{ method: "POST", url: "https://shop.co/graphql?trace=xy&op=AddToCartV2", status: 200 }],
            console: [],
          },
        };
      }
    }
    const driver = new LoggedRequests();
    // A same-prefix operation variant must not satisfy the frozen check.
    await expect(
      conditionMet(driver, { requestStatus: { urlIncludes: "shop.co/graphql?op=AddToCart", status: 200 } }),
    ).resolves.toBe(false);
    // The exact op, with an extra leading param, still satisfies it.
    await expect(
      conditionMet(driver, { requestStatus: { urlIncludes: "shop.co/graphql?op=AddToCartV2", status: 200 } }),
    ).resolves.toBe(true);
  });

  it("conditionMetRoleFilter: until.role constrains the text match to elements of that role", async () => {
    const driver = new StubDriver();
    driver.els = [{ role: "link", name: "Cart" }];
    await expect(conditionMet(driver, { text: "Cart", role: "button" })).resolves.toBe(false);
    await expect(conditionMet(driver, { text: "Cart", role: "link" })).resolves.toBe(true);
    await expect(conditionMet(driver, { text: "Cart" })).resolves.toBe(true);
  });

  it("conditionMetTextSplitAcrossNodesNoMatch: a phrase whose words live in two separate elements is not a match (#95 counter-example) — only a single accessible name containing it is", async () => {
    const driver = new StubDriver();
    driver.els = [
      { role: "StaticText", name: "Order" },
      { role: "StaticText", name: "confirmed" },
    ];
    await expect(conditionMet(driver, { text: "Order confirmed" })).resolves.toBe(false);
    driver.els = [{ role: "heading", name: "Your order confirmed!" }];
    await expect(conditionMet(driver, { text: "Order confirmed" })).resolves.toBe(true);
  });

  it("conditionMetTextTrimAndCaseInsensitive: the text needle is trimmed and matched case-insensitively as a substring of the accessible name", async () => {
    const driver = new StubDriver();
    driver.els = [{ role: "link", name: "Shopping Cart (2)" }];
    await expect(conditionMet(driver, { text: "  cart " })).resolves.toBe(true);
    await expect(conditionMet(driver, { text: "SHOPPING CART" })).resolves.toBe(true);
    await expect(conditionMet(driver, { text: "Checkout" })).resolves.toBe(false);
  });

  it("waitForAllThreeRejectsWhenAnyMissing: a url+request+element waitFor is an AND — dropping any one of the three times out", async () => {
    const handler = new BuiltinStepHandler();
    const until = { url: "/cart", requestStatus: { urlIncludes: "/api/me", status: 200 }, text: "Cart" };
    const step = (): Step => ({ kind: "waitFor", until, timeoutMs: 30 });
    const driver = (
      finalUrl: string,
      requests: Evidence["logic"]["requests"],
      elements: PageElement[],
    ): FakeDriver =>
      new FakeDriver({
        evidence: {
          execution: { actions: [], navigated: true, finalUrl, blocked: false },
          perception: {},
          logic: { requests, console: [] },
        },
        elements,
      });
    const me = [{ method: "GET", url: "https://x/api/me", status: 200 }];
    const cart: PageElement[] = [{ role: "link", name: "Cart" }];

    await expect(handler.execute(step(), driver("https://x/en/cart", me, cart))).resolves.toBeUndefined();
    await expect(handler.execute(step(), driver("https://x/en/home", me, cart))).rejects.toThrow(/waitFor timed out/);
    await expect(handler.execute(step(), driver("https://x/en/cart", [], cart))).rejects.toThrow(/waitFor timed out/);
    await expect(handler.execute(step(), driver("https://x/en/cart", me, []))).rejects.toThrow(/waitFor timed out/);
    await expect(
      handler.execute(
        step(),
        driver("https://x/en/cart", [{ method: "GET", url: "https://x/api/me", status: 401 }], cart),
      ),
    ).rejects.toThrow(/waitFor timed out/);
  });
});
