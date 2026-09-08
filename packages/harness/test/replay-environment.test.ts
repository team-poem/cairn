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
