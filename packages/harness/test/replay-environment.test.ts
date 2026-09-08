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
