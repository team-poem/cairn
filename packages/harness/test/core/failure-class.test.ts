import { describe, expect, it } from "vitest";
import { classifyFailure, finalizeVerdict } from "../../src/core/pipeline.js";
import { runScenario } from "../../src/run.js";
import { FakeDriver } from "../../src/adapters/drivers/fake.js";
import type { Evidence, Scenario } from "../../src/core/types.js";
import { exitCodeFor, suiteExitCode } from "../../src/cli-exit.js";
import type { AssertionResult, ExecutedAction, Verdict } from "../../src/core/types.js";

const ok = (kind: string, extra: Record<string, unknown> = {}): AssertionResult => ({ assertion: { kind, ...extra } as never, passed: true });
const red = (kind: string, detail: string, extra: Record<string, unknown> = {}): AssertionResult => ({ assertion: { kind, ...extra } as never, passed: false, detail });
const verdict = (results: AssertionResult[], detail?: string): Verdict => ({ passed: results.every((r) => r.passed) && detail === undefined, results, ...(detail ? { detail } : {}) });
const blockedBy = (error: string): ExecutedAction[] => [
  { step: { kind: "goto", url: "https://shop.co/" }, ok: true },
  { step: { kind: "click", target: { text: "Buy" } }, ok: false, error },
];

describe("classifyFailure names the red (#173)", () => {
  it("a blocked step is a stale script", () => {
    for (const error of ["element not found: Buy", "post-condition not met: {\"url\":\"shop.co/cart\"}", "waitFor timed out after 2000ms: {\"text\":\"Cart\"}"]) {
      expect(classifyFailure(verdict([ok("navigated")]), blockedBy(error))).toBe("script");
    }
  });

  it("a blocked step whose error names the browser or transport is the environment", () => {
    for (const error of ["browser session ended mid-run (chrome-devtools-mcp transport closed)", "MCP click failed: net::ERR_CONNECTION_REFUSED", "failed to start chrome-devtools-mcp: spawn ENOENT"]) {
      expect(classifyFailure(verdict([ok("navigated")]), blockedBy(error))).toBe("environment");
    }
  });

  it("a freeze that proves nothing is a stale script", () => {
    expect(classifyFailure(verdict([], "scenario has no assertions to verify"))).toBe("script");
    expect(classifyFailure(verdict([ok("navigated", { vacuous: true })], "every assertion was already satisfied before the flow ran — the scenario cannot detect a broken flow"))).toBe("script");
  });

  it("a judge that could not judge is the environment", () => {
    expect(classifyFailure(verdict([red("expect", "LLM judgment failed: 429 rate limited", { criteria: "x" })]))).toBe("environment");
    expect(classifyFailure(verdict([red("custom", 'custom check "stock" needs a registered handler', { name: "stock" })]))).toBe("environment");
  });

  it("a goal that did not hold is the flow", () => {
    expect(classifyFailure(verdict([red("navigated", "final url https://shop.co/error did not reach shop.co/done", { to: "shop.co/done" })]))).toBe("flow");
    expect(classifyFailure(verdict([red("request-status", "no POST request matching /api/orders", { urlIncludes: "/api/orders", status: 200 })]))).toBe("flow");
    expect(classifyFailure(verdict([red("request-status", "expected 200, got 500 for https://shop.co/api/orders", { urlIncludes: "/api/orders", status: 200 })]))).toBe("flow");
  });

  it("a goal request the app refused for credentials or rate is the environment — unless another goal also failed", () => {
    const refused = red("request-status", "expected 200, got 401 for https://shop.co/api/orders", { urlIncludes: "/api/orders", status: 200 });
    expect(classifyFailure(verdict([refused]))).toBe("environment");
    expect(classifyFailure(verdict([red("request-status", "expected 200, got 429 for https://shop.co/api/orders", { urlIncludes: "/api/orders", status: 200 })]))).toBe("environment");
    expect(classifyFailure(verdict([refused, red("navigated", "did not reach", { to: "shop.co/done" })]))).toBe("flow");
  });

  it("guards alone lean to the flow too — a 500 is the same 500 whether a goal or a guard saw it", () => {
    expect(classifyFailure(verdict([ok("navigated"), red("no-failed-requests", "1 failed request(s): 500 https://shop.co/api/me")]))).toBe("flow");
    expect(classifyFailure(verdict([ok("navigated"), red("no-console-errors", "1 console error(s): TypeError: x is undefined")]))).toBe("flow");
    expect(classifyFailure(verdict([ok("navigated"), red("no-failed-requests", "1 failed request(s): 429 https://shop.co/api/me")]))).toBe("environment");
    expect(classifyFailure(verdict([red("navigated", "did not reach", { to: "shop.co/done" }), red("no-console-errors", "1 console error(s)")]))).toBe("flow");
  });

  it("never scans a resolution miss or an MCP payload for environment words — page text is not a transport", () => {
    expect(classifyFailure(verdict([ok("navigated")]), blockedBy('no element matching {"text":"Transport options"}'))).toBe("script");
    expect(classifyFailure(verdict([ok("navigated")]), blockedBy('no element matching {"text":"Public transportation"}'))).toBe("script");
    expect(classifyFailure(verdict([ok("navigated")]), blockedBy("MCP click failed: Payment failed to start"))).toBe("script");
    expect(classifyFailure(verdict([ok("navigated")]), blockedBy("MCP navigate_page failed: net::ERR_CONNECTION_REFUSED"))).toBe("environment");
    expect(classifyFailure(verdict([ok("navigated")]), blockedBy("browser session ended mid-run (chrome-devtools-mcp transport closed) — rerun with a new driver"))).toBe("environment");
  });

  it("reads the whole blocked reason from the detail, past any semicolon in the step's own payload", () => {
    const detail = 'step 2/2 blocked: post-condition not met: {"url":"shop.co/cart; v2"}; MCP observe failed: net::ERR_ABORTED';
    expect(finalizeVerdict(verdict([ok("navigated")]), detail).failure).toBe("environment");
  });

  it("a judge failure beside a real goal failure still reads as the regression", () => {
    const flaky = red("expect", "LLM judgment failed: Anthropic API 429", { criteria: "x" });
    expect(classifyFailure(verdict([flaky, red("navigated", "did not reach", { to: "shop.co/done" })]))).toBe("flow");
    expect(classifyFailure(verdict([flaky]))).toBe("environment");
    expect(classifyFailure(verdict([red("custom", 'no custom check registered for "stock"', { name: "stock" }), red("request-status", "no POST request matching /api/orders", { urlIncludes: "/api/orders", status: 200 })]))).toBe("flow");
  });

  it("refused means every status the critic saw, in either arrival order", () => {
    const rs = (seen: string) => red("request-status", `expected 200, got ${seen} for https://shop.co/api/orders`, { urlIncludes: "/api/orders", status: 200 });
    expect(classifyFailure(verdict([rs("401, 500")]))).toBe("flow");
    expect(classifyFailure(verdict([rs("500, 401")]))).toBe("flow");
    expect(classifyFailure(verdict([rs("401, 403")]))).toBe("environment");
  });

  it("guard text is never scanned for environment words, and a multi-failure guard hides what it did not print", () => {
    expect(classifyFailure(verdict([ok("navigated"), red("no-console-errors", "2 console error(s): transport error")]))).toBe("flow");
    expect(classifyFailure(verdict([ok("navigated"), red("no-failed-requests", "1 failed request(s): 500 https://api.shop.co/transport/quote")]))).toBe("flow");
    expect(classifyFailure(verdict([ok("navigated"), red("no-failed-requests", "4 failed request(s): 429 https://shop.co/api/me")]))).toBe("flow");
    expect(classifyFailure(verdict([ok("navigated"), red("no-failed-requests", "1 failed request(s): 429 https://shop.co/api/me")]))).toBe("environment");
  });

  it("a re-discovery that ended before done is the script, on the bare run as on the suite", () => {
    expect(finalizeVerdict(verdict([ok("navigated")]), "outcome-heal re-discovery ended before `done` (step cap or policy) — unverified path").failure).toBe("script");
  });

  it("an MCP envelope alone is not the environment: an element that never became interactive is the script", () => {
    expect(classifyFailure(verdict([ok("navigated")]), blockedBy("MCP click failed: Failed to interact with the element with uid 12. The element did not become interactive within the configured timeout."))).toBe("script");
    expect(classifyFailure(verdict([ok("navigated")]), blockedBy("MCP navigate_page timed out after 30000ms"))).toBe("environment");
  });

  it("a handler the host never registered is the environment, as a step or as a check", () => {
    expect(classifyFailure(verdict([ok("navigated")]), blockedBy('no handler registered for custom action "stock"'))).toBe("environment");
  });

  it("reads the blocked step from the detail when a caller finalized without actions", () => {
    expect(finalizeVerdict(verdict([ok("navigated")]), "step 2/3 blocked: element not found: Buy (1 later step(s) never ran)").failure).toBe("script");
    expect(finalizeVerdict(verdict([ok("navigated")]), "step 2/2 blocked: browser session ended mid-run").failure).toBe("environment");
  });

  it("a blocked step outranks what the assertions say about the partial run", () => {
    expect(classifyFailure(verdict([red("navigated", "did not reach", { to: "shop.co/done" })]), blockedBy("element not found: Buy"))).toBe("script");
  });

  it("finalizeVerdict stamps the class on a red and never on a green", () => {
    expect(finalizeVerdict(verdict([ok("navigated")]))).not.toHaveProperty("failure");
    expect(finalizeVerdict(verdict([ok("navigated")]), "step 2/2 blocked: element not found: Buy", blockedBy("element not found: Buy")).failure).toBe("script");
    expect(finalizeVerdict(verdict([red("navigated", "did not reach", { to: "x" })])).failure).toBe("flow");
  });
});

describe("exit codes follow the class (#173)", () => {
  const green: Verdict = { passed: true, results: [] };
  const of = (failure: Verdict["failure"]): Verdict => ({ passed: false, results: [], failure });
  it("0 · 1 flow · 3 script · 4 environment, and a red without a class is treated as flow", () => {
    expect(exitCodeFor(green)).toBe(0);
    expect(exitCodeFor(of("flow"))).toBe(1);
    expect(exitCodeFor(of("script"))).toBe(3);
    expect(exitCodeFor(of("environment"))).toBe(4);
    expect(exitCodeFor({ passed: false, results: [] })).toBe(1);
  });
  it("a suite exits with its most demanding failure: block before re-discover before retry", () => {
    expect(suiteExitCode([green, green])).toBe(0);
    expect(suiteExitCode([of("environment"), of("script")])).toBe(3);
    expect(suiteExitCode([of("environment"), of("script"), of("flow")])).toBe(1);
    expect(suiteExitCode([of("environment")])).toBe(4);
  });
});

describe("the class rides the real replay and heal paths (#173)", () => {
  const evidence: Evidence = {
    execution: { actions: [], navigated: true, finalUrl: "https://shop.co/done", blocked: false },
    perception: {},
    logic: { requests: [], console: [] },
  };
  const scenario: Scenario = {
    name: "buy",
    steps: [{ kind: "goto", url: "https://shop.co/" }, { kind: "click", target: { text: "Buy" } }],
    assertions: [{ kind: "navigated", to: "shop.co/done" }],
  };
  const silent = { emit: async () => {} };

  it("a replay whose step cannot resolve its target is a stale script", async () => {
    const { result } = await runScenario(scenario, { driver: new FakeDriver({ evidence, failOn: ["Buy"] }), reporter: silent });
    expect(result.verdict.passed).toBe(false);
    expect(result.verdict.failure).toBe("script");
  });

  it("a green replay carries no class", async () => {
    const { result } = await runScenario(scenario, { driver: new FakeDriver({ evidence }), reporter: silent });
    expect(result.verdict.passed).toBe(true);
    expect(result.verdict).not.toHaveProperty("failure");
  });

  it("a replay that reached the wrong page is the flow", async () => {
    const elsewhere = { ...evidence, execution: { ...evidence.execution, finalUrl: "https://shop.co/error" } };
    const { result } = await runScenario(scenario, { driver: new FakeDriver({ evidence: elsewhere }), reporter: silent });
    expect(result.verdict.failure).toBe("flow");
  });
});
