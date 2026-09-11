import { describe, expect, it } from "vitest";
import { AssertionCritic } from "../../../src/adapters/critics/assertion.js";
import { discover } from "../../../src/core/discover/index.js";
import { markObservedBeforeLastMutation } from "../../../src/core/discover/grounding.js";
import type { OutcomeMark } from "../../../src/core/discover/capture.js";
import { provesAnAction } from "../../../src/core/freeze.js";
import type { Assertion, Evidence, NetworkRequest, Target } from "../../../src/core/types.js";
import { ScriptedLlm, StubDriver } from "../../support/doubles.js";

const home = "https://shop.test/home";
const signin = "https://shop.test/signin";
const post: NetworkRequest = { method: "POST", url: "https://shop.test/api/signin", status: 200 };
const nav: Assertion = { kind: "navigated", to: "shop.test/signin", origin: "derived" };
const evidence = (requests: NetworkRequest[], url = signin): Evidence => ({
  execution: { actions: [], navigated: true, finalUrl: url, blocked: false },
  perception: {},
  logic: { requests, console: [] },
});
const marks: (OutcomeMark | null)[] = [null, { url: home, requestCount: 0 }, { url: signin, requestCount: 0 }];

describe("navigation evidence provenance (#203)", () => {
  it("marks a destination reached before submit even when the request check survives", () => {
    const request: Assertion = { kind: "request-status", urlIncludes: "/api/signin", method: "POST", status: 200, origin: "derived" };
    const assertions = markObservedBeforeLastMutation([nav, request], marks, evidence([post]));
    expect(assertions).toEqual([{ ...nav, observedBeforeLastMutation: true }, request]);
    expect(nav).not.toHaveProperty("observedBeforeLastMutation");
  });

  it("does not require a stable request path", () => {
    const assertions = markObservedBeforeLastMutation([nav], marks, evidence([{ ...post, url: "https://shop.test/123456" }]));
    expect(assertions[0]).toHaveProperty("observedBeforeLastMutation", true);
  });

  it("keeps an on-page save advisory without changing the verdict or request proof", async () => {
    const assertions = markObservedBeforeLastMutation([
      { ...nav, vacuous: true },
      { kind: "request-status", urlIncludes: "/api/signin", method: "POST", status: 200, origin: "derived" },
    ], marks, evidence([post]));
    expect(assertions[0]).toMatchObject({ vacuous: true, observedBeforeLastMutation: true });
    expect((await new AssertionCritic().judge(evidence([post]), assertions)).passed).toBe(true);
    expect(provesAnAction({ name: "save", steps: [], assertions })).toBe(true);
  });

  it("does not flag a destination reached after the mutation", () => {
    const redirected: Assertion = { ...nav, to: "shop.test/account" };
    expect(markObservedBeforeLastMutation([redirected], marks, evidence([post], "https://shop.test/account"))).toEqual([redirected]);
  });

  it("retains the last mutation's boundary through a later scroll or wait", () => {
    const trailing = [...marks, { url: signin, requestCount: 1 }, { url: signin, requestCount: 1 }];
    expect(markObservedBeforeLastMutation([nav], trailing, evidence([post]))[0]).toHaveProperty("observedBeforeLastMutation", true);
  });

  it("uses only the latest mutation-bearing step, not an earlier matching URL", () => {
    const later = [...marks, { url: "https://shop.test/confirm", requestCount: 1 }];
    expect(markObservedBeforeLastMutation([nav], later, evidence([post, post]))).toEqual([nav]);
    expect(markObservedBeforeLastMutation([nav], later, evidence([post, { ...post, method: "GET" }]))[0]).toHaveProperty("observedBeforeLastMutation", true);
  });

  it.each([
    ["read", { ...post, method: "GET" }, []],
    ["pending", { ...post, status: 0 }, []],
    ["informational", { ...post, status: 101 }, []],
    ["failed", { ...post, status: 400 }, []],
    ["third party", { ...post, url: "https://metrics.test/events" }, []],
    ["built-in benign", { ...post, url: "https://shop.test/favicon.ico" }, []],
    ["product benign", post, ["/api/signin"]],
  ] as const)("excludes %s traffic", (_label, request, benign) => {
    expect(markObservedBeforeLastMutation([nav], marks, evidence([request]), { benign })).toEqual([nav]);
  });

  it("excludes entry traffic and flows with no executed action marks", () => {
    expect(markObservedBeforeLastMutation([nav], [null, { url: signin, requestCount: 1 }], evidence([post]))).toEqual([nav]);
    expect(markObservedBeforeLastMutation([nav], [null], evidence([post]))).toEqual([nav]);
  });

  it("includes successful redirect statuses and API subdomains of a visited page", () => {
    expect(markObservedBeforeLastMutation([nav], marks, evidence([{ ...post, method: "patch", status: 302, url: "https://api.shop.test/save" }]))[0]).toHaveProperty("observedBeforeLastMutation", true);
  });

  it("honors injected locale prefixes and explicit wildcard matching", () => {
    const localized = [{ url: "https://shop.test/fr-ca/signin", requestCount: 0 }];
    expect(markObservedBeforeLastMutation([nav], localized, evidence([post]), { localePrefixes: ["fr-ca"] })[0]).toHaveProperty("observedBeforeLastMutation", true);
    expect(markObservedBeforeLastMutation([nav], localized, evidence([post]), { localePrefixes: [] })).toEqual([nav]);
    const order: Assertion = { ...nav, to: "shop.test/orders/*/confirmation" };
    const orderMarks = [{ url: "https://shop.test/orders/123456/confirmation", requestCount: 0 }];
    expect(markObservedBeforeLastMutation([order], orderMarks, evidence([post]), { wildcards: true })[0]).toHaveProperty("observedBeforeLastMutation", true);
    expect(markObservedBeforeLastMutation([order], orderMarks, evidence([post]), { wildcards: false })).toEqual([order]);
  });

  it("never stamps user-origin, unknown-origin, or destinationless assertions", () => {
    const assertions: Assertion[] = [{ ...nav, origin: "user" }, { ...nav, origin: undefined }, { kind: "navigated", origin: "derived" }];
    expect(markObservedBeforeLastMutation(assertions, marks, evidence([post]))).toEqual(assertions);
  });
});

describe("discover navigation provenance (#203)", () => {
  it.each([
    { before: "/fr-ca/signin", after: "/signin", locales: ["fr-ca"], marked: true },
    { before: "/fr-ca/signin", after: "/signin", locales: [], marked: false },
    { before: "/orders/123456/confirmation", after: "/orders/987654/confirmation", locales: [], marked: true },
  ])("uses freeze matching options for $before → $after (locales=$locales)", async ({ before, after, locales, marked }) => {
    class MatchingDriver extends StubDriver {
      requests: NetworkRequest[] = [];
      override async click(target: Target): Promise<void> {
        this.url = `https://shop.test${target.text === "Open" ? before : after}`;
        if (target.text === "Submit") this.requests.push(post);
      }
      override async observe(): Promise<Evidence> {
        return evidence([...this.requests], this.url);
      }
    }
    const scenario = await discover("submit", {
      driver: new MatchingDriver(home), baseUrl: home, localePrefixes: locales,
      llm: new ScriptedLlm(['{"action":"click","text":"Open"}', '{"action":"click","text":"Submit"}', '{"action":"done"}']),
    });
    const assertion = scenario.assertions.find((a) => a.kind === "navigated");
    expect(assertion?.observedBeforeLastMutation).toBe(marked ? true : undefined);
    if (after.includes("987654")) {
      expect(assertion?.to).toBe("shop.test/orders/*/confirmation");
      expect(scenario.wildcards).toBe(true);
    }
  });

  class LoginDriver extends StubDriver {
    requests: NetworkRequest[] = [];
    constructor(private readonly redirect = false) {
      super(home);
      this.navOn.Open = signin;
    }
    override async click(target: Target): Promise<void> {
      await super.click(target);
      if (target.text === "Submit") {
        this.requests.push(post);
        if (this.redirect) this.url = "https://shop.test/account";
      }
    }
    override async observe(): Promise<Evidence> {
      return evidence([...this.requests], this.url);
    }
  }

  it.each([false, true])("freezes the observed destination with an advisory only when submit did not redirect (redirect=%s)", async (redirect) => {
    const driver = new LoginDriver(redirect);
    const scenario = await discover("sign in", {
      driver,
      baseUrl: home,
      llm: new ScriptedLlm([
        '{"action":"click","text":"Open"}',
        '{"action":"click","text":"Submit"}',
        '{"action":"scroll","direction":"down"}',
        '{"action":"done"}',
        '[{"kind":"request-status","urlIncludes":"/api/signin","method":"POST","status":200}]',
      ]),
    });
    expect(scenario.assertions.find((a) => a.kind === "navigated")).toEqual({
      kind: "navigated", origin: "derived", to: redirect ? "shop.test/account" : "shop.test/signin",
      ...(redirect ? {} : { observedBeforeLastMutation: true }),
    });
    expect(scenario.steps[1]?.expect).toEqual({ url: "shop.test/signin" });
    expect(scenario.steps[2]?.expect).toEqual(redirect
      ? { url: "shop.test/account" }
      : { requestStatus: { urlIncludes: "shop.test/api/signin", method: "POST", status: 200 } });
    expect(provesAnAction(scenario)).toBe(true);
    expect((await new AssertionCritic().judge(await driver.observe(), scenario.assertions)).passed).toBe(true);
    expect(JSON.parse(JSON.stringify(scenario)).assertions).toEqual(scenario.assertions);
  });
});
