// file: packages/harness/test/replay-environment.test.ts
import { expect, test, vi } from "vitest";
import { runScenario } from "../src/run.js";
import { runSuite, hashCase } from "../src/suite.js";
import { urlMatchesFrozen, findRequestStatus } from "../src/core/requests.js";
import { FakeDriver } from "../src/adapters/drivers/fake.js";
import { StubDriver, ScriptedLlm } from "./support/doubles.js";
import type { Driver } from "../src/core/ports.js";
import type { Evidence, NetworkRequest, Scenario, Target } from "../src/core/types.js";
const env = { baseUrl: "http://localhost:3000", allowedHosts: ["stage.test", "api.stage.test", "localhost:4000"] };
const silent = { emit: async () => {} };
const scenario = (): Scenario => ({ name: "checkout", steps: [{ kind: "goto", url: "https://stage.test/start" }], assertions: [{ kind: "navigated", to: "stage.test/start" }] });
class EnvDriver extends StubDriver {
  visited: string[] = [];
  requests: NetworkRequest[] = [];
  override async goto(url: string): Promise<void> { this.visited.push(url); await super.goto(url); }
  override async observe(): Promise<Evidence> { const e = await super.observe(); return { ...e, logic: { ...e.logic, requests: [...this.requests] } }; }
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

test("replayEnvironmentRunsAtTarget: every navigation surface agrees without changing frozen data", async () => {
  const s: Scenario = freezeDeep({ name: "checkout", wildcards: true, steps: [
    { kind: "goto", url: "https://stage.test/en/start?from=cart#top", expect: { url: "stage.test/en/start" } },
    { kind: "goto", url: "https://stage.test/xx/orders/42?done=1#receipt" },
    { kind: "waitFor", until: { url: "stage.test/en/orders/*" }, timeoutMs: 1 },
  ], assertions: [{ kind: "navigated", to: "stage.test/en/orders/*" }] });
  const original = JSON.stringify(s);
  const driver = new EnvDriver();
  const complete = vi.fn(async () => { throw new Error("LLM forbidden"); });
  const { result } = await runScenario(s, { driver, reporter: silent, replayEnvironment: env,
    localePrefixes: ["en", "xx"], expectTimeoutMs: 1, llm: { id: "forbidden", complete } });
  expect(result.verdict.passed).toBe(true);
  expect(driver.visited).toEqual(["http://localhost:3000/en/start?from=cart#top", "http://localhost:3000/xx/orders/42?done=1#receipt"]);
  expect(result.evidence.execution.finalUrl).toBe("http://localhost:3000/xx/orders/42?done=1#receipt");
  expect(result.usage?.llmCalls).toBe(0);
  expect(complete).not.toHaveBeenCalled();
  expect(JSON.stringify(s)).toBe(original);
});

test("replayEnvironmentPreservesExtensions: custom code sees real URLs and external navigation stays external", async () => {
  const params = { url: "https://stage.test/custom-data" };
  const s: Scenario = { ...scenario(), steps: [...scenario().steps, { kind: "custom", name: "inspect", params },
    { kind: "goto", url: "https://pay.test/checkout" }], assertions: [
    { kind: "navigated", to: "pay.test/checkout" }, { kind: "custom", name: "inspect", params }] };
  const driver = new EnvDriver();
  const action = vi.fn(async (d: Driver, p: Record<string, unknown>) => { expect(p).toBe(params); expect((await d.observe()).execution.finalUrl).toBe("http://localhost:3000/start"); });
  const check = vi.fn(async (p: Record<string, unknown>, e: Evidence) => { expect(p).toBe(params); expect(e.execution.finalUrl).toBe("https://pay.test/checkout"); return true; });
  const { result } = await runScenario(s, { driver, reporter: silent, replayEnvironment: env, actions: { inspect: action }, custom: { inspect: check } });
  expect(result.verdict.passed).toBe(true);
  expect(driver.visited).toEqual(["http://localhost:3000/start", "https://pay.test/checkout"]);
  expect(action).toHaveBeenCalledOnce(); expect(check).toHaveBeenCalledOnce();
  const originalDriver = new EnvDriver();
  expect((await runScenario(scenario(), { driver: originalDriver, reporter: silent })).result.verdict.passed).toBe(true);
  expect(originalDriver.visited).toEqual(["https://stage.test/start"]);
});

test("replayRequestHostGate: only two allowed hosts may share a stable request path", () => {
  const opts = { allowedHosts: [...env.allowedHosts, "localhost:3000"] };
  const rows: [string, string, boolean][] = [
    ["http://localhost:4000/graphql?trace=x&op=AddToCart", "api.stage.test/graphql?op=AddToCart", true],
    ["http://localhost:3000/orders/123", "https://api.stage.test/orders", true],
    ["https://pay.test/graphql?op=AddToCart", "api.stage.test/graphql?op=AddToCart", false],
    ["http://localhost:4001/graphql?op=AddToCart", "api.stage.test/graphql?op=AddToCart", false],
    ["https://api.stage.test.evil.test/graphql", "api.stage.test/graphql", false],
    ["http://localhost:4000/graphql?op=AddToCart", "evil.test/graphql?op=AddToCart", false],
    ["http://localhost:4000/graphql?op=AddToCartV2", "api.stage.test/graphql?op=AddToCart", false],
    ["http://localhost:4000/graphql", "api.stage.test/graphql?op=AddToCart", false],
    ["http://localhost:4000/elsewhere?next=api.stage.test/graphql", "api.stage.test/graphql", false],
    ["https://evil.test/collect?next=https://api.stage.test/graphql?op=Save", "https://api.stage.test/graphql?op=Save", false],
    ["http://localhost:4000/other?next=/graphql", "api.stage.test/graphql", false],
    ["http://localhost:4000/", "api.stage.test", false],
    ["http://localhost:4000/?op=Save", "api.stage.test/?op=Save", false],
    ["http://localhost:4000/?op=Save", "api.stage.test?op=Save", false],
    ["http://localhost:4000/", "api.stage.test/", false],
    ["https://pay.test/graphql?op=Save", "pay.test/graphql?op=Save", true],
    ["http://localhost:4000/graphql?op=Save", "/graphql?op=Save", true],
  ];
  for (const [actual, frozen, want] of rows) expect(urlMatchesFrozen(actual, frozen, opts), `${actual} / ${frozen}`).toBe(want);
  expect(urlMatchesFrozen("http://localhost:4000/graphql", "api.stage.test/graphql")).toBe(false);
  const requests = [
    { method: "GET", status: 200, url: "http://localhost:4000/graphql?op=Save" },
    { method: "POST", status: 401, url: "http://localhost:4000/graphql?op=Save" },
    { method: "POST", status: 200, url: "http://localhost:4000/graphql?trace=1&op=Save" },
  ];
  expect(findRequestStatus(requests, "api.stage.test/graphql?op=Save", 200, "post", opts)).toBe(requests[2]);
  expect(findRequestStatus(requests.slice(0, 2), "api.stage.test/graphql?op=Save", 200, "POST", opts)).toBeUndefined();
});

test("replayRequestChecksAgree: expect waitFor and critic share request matching", async () => {
  for (const host of ["localhost:4000", "localhost:3000", "pay.test"]) {
    const driver = new (class extends EnvDriver {
      override async click(t: Target): Promise<void> { await super.click(t); this.requests.push({ method: "POST", status: 200, url: `http://${host}/graphql?trace=x&op=Save` }); }
    })();
    const requestStatus = { urlIncludes: "api.stage.test/graphql?op=Save", status: 200, method: "POST" };
    const s: Scenario = { ...scenario(), steps: [...scenario().steps,
      { kind: "click", target: { text: "Save" }, expect: { requestStatus } },
      { kind: "waitFor", until: { requestStatus }, timeoutMs: 1 }], assertions: [{ kind: "request-status", ...requestStatus }] };
    const { result } = await runScenario(s, { driver, reporter: silent, replayEnvironment: env, expectTimeoutMs: 1 });
    expect(result.verdict.passed, host).toBe(host !== "pay.test");
    expect(driver.clicked).toEqual(["Save"]);
  }
  const near = new EnvDriver();
  near.requests.push({ method: "POST", status: 401, url: "http://localhost:4000/graphql?op=Save" });
  const diagnostic = await runScenario({ ...scenario(), steps: [], assertions: [{ kind: "request-status", urlIncludes: "api.stage.test/graphql?op=Save", status: 200, method: "POST" }] }, { driver: near, reporter: silent, replayEnvironment: env });
  expect(diagnostic.result.verdict.results[0]?.statuses).toEqual([401]);
  expect(diagnostic.result.verdict.results[0]?.detail).toContain("401");
  const stale = new EnvDriver();
  stale.requests.push({ method: "POST", status: 200, url: "http://localhost:4000/graphql?op=Save" });
  const s: Scenario = { ...scenario(), steps: [{ kind: "click", target: { text: "Save" }, expect: {
    requestStatus: { urlIncludes: "api.stage.test/graphql?op=Save", status: 200, method: "POST" } } }] };
  const { result } = await runScenario(s, { driver: stale, reporter: silent, replayEnvironment: env, expectTimeoutMs: 1 });
  expect(result.evidence.execution.blocked).toBe(true);
});

test("replayEnvironmentRejectsInvalid: malformed origins and host scopes fail before driver use", async () => {
  const invalid = [
    { ...env, baseUrl: "localhost:3000" }, { ...env, baseUrl: "file:///tmp/x" },
    { ...env, baseUrl: "https://user:secret@localhost:3000" },
    { ...env, baseUrl: "http://localhost:3000/mount" }, { ...env, baseUrl: "http://localhost:3000/?q=x" },
    { ...env, baseUrl: "http://localhost:3000/#part" }, { ...env, allowedHosts: [] },
    ...["", "*.test", "https://stage.test", "stage.test/path", "stage.test?x=1", "stage.test#x", "user@stage.test"].map((host) => ({ ...env, allowedHosts: [host] })),
  ];
  for (const replayEnvironment of invalid) {
    const driver = new EnvDriver();
    const observe = vi.spyOn(driver, "observe");
    await expect(runScenario(scenario(), { driver, reporter: silent, replayEnvironment })).rejects.toThrow(/baseUrl|allowedHosts|replayEnvironment/);
    expect(driver.visited).toEqual([]); expect(observe).not.toHaveBeenCalled();
  }
});

test("replayEnvironmentHealsTemporarily: all repair layers withhold re-freezable scenario", async () => {
  const source: Scenario = freezeDeep({ ...scenario(), steps: [...scenario().steps, { kind: "click", target: { text: "Old" } }] });
  const locatorDriver = new FakeDriver({ evidence: { execution: { actions: [], navigated: true, finalUrl: "http://localhost:3000/start", blocked: false }, perception: {}, logic: { requests: [], console: [] } }, failOn: ["Old"], elements: [{ role: "button", name: "New" }] });
  const locator = await runScenario(source, { driver: locatorDriver, reporter: silent, replayEnvironment: env, heal: true, llm: new ScriptedLlm(['{"name":"New"}']) });
  expect(locator.result.verdict.passed).toBe(true); expect(locator.heals).toHaveLength(1); expect(locator.healedScenario).toBeUndefined();
  const surgicalDriver = new EnvDriver(); surgicalDriver.navOn.New = "http://localhost:3000/done";
  surgicalDriver.els = [{ role: "button", name: "New" }];
  const surgicalScenario: Scenario = { ...scenario(), steps: [...scenario().steps, { kind: "click", target: { text: "Old" }, intent: "finish", expect: { url: "stage.test/done" } }], assertions: [{ kind: "navigated", to: "stage.test/done" }] };
  const surgical = await runScenario(surgicalScenario, { driver: surgicalDriver, reporter: silent, replayEnvironment: env, heal: true, expectTimeoutMs: 1, llm: new ScriptedLlm(['{"action":"click","text":"New"}']) });
  expect(surgical.result.verdict.passed).toBe(true); expect(surgical.stepHeals).toHaveLength(1); expect(surgical.healedScenario).toBeUndefined();
  const outcomeDriver = new EnvDriver(); outcomeDriver.navOn.Finish = "http://localhost:3000/done";
  outcomeDriver.els = [{ role: "button", name: "Finish" }];
  const outcomeScenario: Scenario = { ...scenario(), assertions: [{ kind: "navigated", to: "stage.test/done" }] };
  const outcome = await runScenario(outcomeScenario, { driver: outcomeDriver, reporter: silent, replayEnvironment: env, heal: true, llm: new ScriptedLlm(['{"action":"click","text":"Finish"}', '{"action":"done"}', '[]']) });
  expect(outcome.result.verdict.passed).toBe(true);
  expect(outcomeDriver.visited).toEqual(["http://localhost:3000/start", "http://localhost:3000/start"]);
  expect(outcome.healedScenario).toBeUndefined(); expect(source.steps[0]).toEqual(scenario().steps[0]);
});

test("replayEnvironmentSuiteCache: target origin never changes case identity or stored repair", async () => {
  const c = { id: "checkout", intent: "checkout", url: "https://stage.test/start" };
  const frozen = freezeDeep({ ...scenario(), caseHash: hashCase(c) });
  const load = vi.fn(async () => frozen); const freeze = vi.fn(async (ref: string) => ref);
  const drivers: EnvDriver[] = [];
  const suite = await runSuite([c], { store: { load, freeze }, replayEnvironment: env, reporter: silent,
    driverFactory: () => { const d = new EnvDriver(); drivers.push(d); return d; },
    llm: { id: "forbidden", complete: async () => { throw new Error("discovery forbidden"); } } });
  expect(suite.passed).toBe(true); expect(suite.usage.llmCalls).toBe(0);
  expect(suite.verdicts[0]?.discovered).toBe(false); expect(drivers).toHaveLength(1);
  expect(drivers[0]?.visited).toEqual(["http://localhost:3000/start"]); expect(freeze).not.toHaveBeenCalled();
  expect(frozen.caseHash).toBe(hashCase(c)); expect(frozen.steps[0]).toEqual(scenario().steps[0]);
  const broken: Scenario = { ...frozen, steps: [...frozen.steps, { kind: "click", target: { text: "Old" } }] };
  const repair = await runSuite([c], { store: { load: async () => broken, freeze }, replayEnvironment: env, reporter: silent,
    driverFactory: () => new FakeDriver({ evidence: { execution: { actions: [], navigated: true, finalUrl: "http://localhost:3000/start", blocked: false }, perception: {}, logic: { requests: [], console: [] } }, failOn: ["Old"], elements: [{ role: "button", name: "New" }] }),
    llm: new ScriptedLlm(['{"name":"New"}']) });
  expect(repair.passed).toBe(true); expect(repair.verdicts[0]?.heals).toBe(1); expect(freeze).not.toHaveBeenCalled();
  const fallbackCase = { id: c.id, intent: c.intent };
  expect(hashCase(fallbackCase, c.url)).toBe(frozen.caseHash);
  const fallbackDriver = new EnvDriver();
  const fallback = await runSuite([fallbackCase], { baseUrl: c.url, replayEnvironment: env,
    store: { load, freeze }, driverFactory: () => fallbackDriver, reporter: silent, heal: false });
  expect(fallback.passed).toBe(true); expect(fallback.verdicts[0]?.discovered).toBe(false);
  expect(fallbackDriver.visited).toEqual(["http://localhost:3000/start"]); expect(freeze).not.toHaveBeenCalled();
});

test("replayEnvironmentSuiteMiss: cache-only environment cannot discover or overwrite canonical skills", async () => {
  const c = { id: "checkout", intent: "checkout", url: "https://stage.test/start" };
  for (const stale of [false, true]) {
    const load = vi.fn(async () => { if (!stale) throw new Error("missing"); return { ...scenario(), caseHash: "old" }; });
    const freeze = vi.fn(async (ref: string) => ref); const factory = vi.fn(() => new EnvDriver());
    const complete = vi.fn(async () => '{"action":"done"}');
    const suite = await runSuite([c], { store: { load, freeze }, driverFactory: factory, reporter: silent, replayEnvironment: env, llm: { id: "forbidden", complete } });
    expect(suite.passed).toBe(false); expect(suite.verdicts[0]?.verdict.detail).toMatch(/cache|frozen|discover/i);
    expect(factory).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(freeze).not.toHaveBeenCalled();
    expect(suite.usage.llmCalls).toBe(0);
  }
});

test("replayRequestPreservesEndpointAnchor: unrelated nested endpoint cannot make replay green", async () => {
  for (const host of ["api.stage.test", "localhost:4000"]) {
    const driver = new EnvDriver();
    driver.requests.push({ method: "POST", status: 200, url: `http://${host}/proxy/graphql?op=Save` });
    const s: Scenario = { name: "save", steps: [], assertions: [
      { kind: "request-status", urlIncludes: "api.stage.test/graphql?op=Save", status: 200, method: "POST" },
    ] };
    const { result } = await runScenario(s, { driver, reporter: silent, replayEnvironment: env });
    expect(result.verdict.passed, host).toBe(false);
    expect(result.verdict.results[0]?.passed, host).toBe(false);
    expect(result.usage?.llmCalls).toBe(0);
  }
});

test("replayRequestPathPrefix: scoped endpoint stays anchored at the start of the pathname", () => {
  const opts = { allowedHosts: ["api.stage.test", "localhost:4000"] };
  const frozen = "api.stage.test/graphql?op=Save";
  for (const host of opts.allowedHosts) {
    for (const [path, want] of [
      ["/graphql", true], ["/graphql/v2", true],
      ["/proxy/graphql", false], ["/archive/graphql/v2", false],
    ] as const) {
      const actual = `http://${host}${path}?trace=1&op=Save`;
      expect(urlMatchesFrozen(actual, frozen, opts), actual).toBe(want);
    }
  }
  expect(urlMatchesFrozen("https://api.stage.test/proxy/graphql?op=Save", frozen)).toBe(false);
  expect(urlMatchesFrozen("https://api.stage.test/graphql/v2?op=Save", frozen)).toBe(true);
  const nested = "http://localhost:4000/proxy/graphql?op=Save";
  expect(urlMatchesFrozen(nested, "/graphql?op=Save", opts)).toBe(true);
  expect(urlMatchesFrozen(nested, "/graphql?op=Save")).toBe(true);
});

test("replayEnvironmentCanonicalHostAliases: normalized host aliases always navigate at the replay target", async () => {
  const cases = [
    { host: "stage.test:443", url: "https://stage.test:443/cart" },
    { host: "stage.test:80", url: "http://stage.test:80/cart" },
    { host: "münich.test", url: "https://münich.test/cart" },
    { host: "[0:0:0:0:0:0:0:1]:8080", url: "http://[0:0:0:0:0:0:0:1]:8080/cart" },
  ];
  for (const { host, url } of cases) {
    const s: Scenario = { name: "cart", steps: [{ kind: "goto", url }],
      assertions: [{ kind: "navigated", to: `${host}/cart` }] };
    const driver = new EnvDriver();
    const { result } = await runScenario(s, { driver, reporter: silent,
      replayEnvironment: { baseUrl: "http://localhost:3000", allowedHosts: [host] } });
    expect(driver.visited, host).toEqual(["http://localhost:3000/cart"]);
    expect(result.verdict.passed, host).toBe(true);
    expect(result.evidence.execution.finalUrl, host).toBe("http://localhost:3000/cart");
    expect(result.usage?.llmCalls).toBe(0);
    expect(s.steps[0]).toEqual({ kind: "goto", url });
    expect(s.assertions[0]).toEqual({ kind: "navigated", to: `${host}/cart` });
  }
});

test("replayHostCanonicalMatching: page and request host aliases preserve explicit port scope", async () => {
  const { reanchorScenario } = await import("../src/core/replay-environment.js");
  const cases = [
    { host: "STAGE.TEST:443", origin: "https://stage.test", wrongPort: "https://stage.test:8443", oppositeDefault: "http://stage.test" },
    { host: "STAGE.TEST:80", origin: "http://stage.test", wrongPort: "http://stage.test:8080", oppositeDefault: "https://stage.test" },
    { host: "münich.test", origin: "https://xn--mnich-kva.test", wrongPort: "https://xn--mnich-kva.test:8443" },
    { host: "[0:0:0:0:0:0:0:1]:8080", origin: "http://[::1]:8080", wrongPort: "http://[::1]:8081" },
  ];
  for (const { host, origin, wrongPort, oppositeDefault } of cases) {
    const config = { baseUrl: "http://localhost:3000", allowedHosts: [host] };
    const s: Scenario = { name: "cart", steps: [{ kind: "goto", url: `${origin}/cart` }],
      assertions: [{ kind: "navigated", to: `${host}/cart` }] };
    const mapped = reanchorScenario(s, config);
    expect(mapped.steps[0], host).toEqual({ kind: "goto", url: "http://localhost:3000/cart" });
    expect(mapped.assertions[0], host).toEqual({ kind: "navigated", to: "localhost:3000/cart" });
    const opts = { allowedHosts: [host, "LOCALHOST:3000"] };
    for (const frozen of [`${host}/graphql?op=Save`, `${origin}/graphql?op=Save`]) {
      expect(urlMatchesFrozen(`${origin}/graphql?trace=1&op=Save`, frozen, opts), `${host} source ${frozen}`).toBe(true);
      expect(urlMatchesFrozen("http://localhost:3000/graphql?trace=1&op=Save", frozen, opts), `${host} target ${frozen}`).toBe(true);
      expect(urlMatchesFrozen(`${wrongPort}/graphql?op=Save`, frozen, opts), `${host} source port ${frozen}`).toBe(false);
      expect(urlMatchesFrozen("http://localhost:3001/graphql?op=Save", frozen, opts), `${host} target port ${frozen}`).toBe(false);
      if (oppositeDefault) {
        expect(urlMatchesFrozen(`${oppositeDefault}/graphql?op=Save`, frozen, opts), `${host} opposite default ${frozen}`).toBe(false);
      }
    }
    const external: Scenario = { name: "external", steps: [{ kind: "goto", url: `${wrongPort}/cart` }], assertions: [] };
    expect(reanchorScenario(external, config).steps[0], host).toBe(external.steps[0]);
    if (oppositeDefault) {
      const opposite: Scenario = { name: "opposite", steps: [{ kind: "goto", url: `${oppositeDefault}/cart` }], assertions: [] };
      expect(reanchorScenario(opposite, config).steps[0], host).toBe(opposite.steps[0]);
      expect(urlMatchesFrozen("http://localhost:3000/graphql?op=Save", `${oppositeDefault}/graphql?op=Save`, opts), `${host} unscoped frozen default`).toBe(false);
    }
  }
});
