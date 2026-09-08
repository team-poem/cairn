import { describe, expect, it } from "vitest";
import { classifyFailure, finalizeVerdict } from "../../src/core/pipeline.js";
import { errorKindOf, stepError } from "../../src/core/errors.js";
import { exitCodeFor, suiteExitCode } from "../../src/cli-exit.js";
import { checkAssertion, toVerdict } from "../../src/adapters/critics/assertion.js";
import { LlmCritic } from "../../src/adapters/critics/llm.js";
import { mcpToolError } from "../../src/adapters/drivers/chrome.js";
import { runScenario } from "../../src/run.js";
import { FakeDriver } from "../../src/adapters/drivers/fake.js";
import type { AssertionResult, Evidence, ExecutedAction, Scenario, StepErrorKind, Verdict } from "../../src/core/types.js";

const ok = (kind: string, extra: Record<string, unknown> = {}): AssertionResult => ({ assertion: { kind, ...extra } as never, passed: true });
const red = (kind: string, fields: Partial<AssertionResult> = {}, extra: Record<string, unknown> = {}): AssertionResult =>
  ({ assertion: { kind, ...extra } as never, passed: false, detail: "…", ...fields });
const verdict = (results: AssertionResult[], fields: Partial<Verdict> = {}): Verdict =>
  ({ passed: results.every((r) => r.passed) && fields.failClosed === undefined, results, ...fields });
const blockedBy = (errorKind?: StepErrorKind): ExecutedAction[] => [
  { step: { kind: "goto", url: "https://shop.co/" }, ok: true },
  { step: { kind: "click", target: { text: "Buy" } }, ok: false, error: "…", ...(errorKind ? { errorKind } : {}) },
];
const request = (statuses: number[]) => red("request-status", { statuses }, { urlIncludes: "/api/orders", status: 200 });
const guard = (statuses: number[]) => red("no-failed-requests", { statuses });

describe("classifyFailure names the red from structured signals (#173, #212)", () => {
  it("a blocked step is a stale script — resolution, post-condition, timeout, or an untyped throw", () => {
    for (const kind of ["resolution", "post-condition", "timeout", undefined] as const) {
      expect(classifyFailure(verdict([ok("navigated")]), blockedBy(kind))).toBe("script");
    }
  });

  it("a blocked step whose kind is the machine's or the host's wiring is the environment", () => {
    expect(classifyFailure(verdict([ok("navigated")]), blockedBy("transport"))).toBe("environment");
    expect(classifyFailure(verdict([ok("navigated")]), blockedBy("handler"))).toBe("environment");
  });

  it("a blocked step outranks what the assertions say about the partial run", () => {
    expect(classifyFailure(verdict([red("navigated", {}, { to: "x" })]), blockedBy("resolution"))).toBe("script");
    expect(classifyFailure(verdict([guard([500])]), blockedBy("transport"))).toBe("environment");
  });

  it("failing closed — no assertions, all vacuous, blocked without actions, a truncated re-discovery — is a stale script", () => {
    for (const failClosed of ["no-assertions", "all-vacuous", "blocked", "truncated"] as const) {
      expect(classifyFailure(verdict([], { failClosed }))).toBe("script");
    }
  });

  it("a goal that did not hold is the flow", () => {
    expect(classifyFailure(verdict([red("navigated", {}, { to: "shop.co/done" })]))).toBe("flow");
    expect(classifyFailure(verdict([red("request-status", {}, { urlIncludes: "/api/orders", status: 200 })]))).toBe("flow"); // never fired
    expect(classifyFailure(verdict([request([500])]))).toBe("flow");
  });

  it("refused means every observed status, pending ones included, in any order", () => {
    expect(classifyFailure(verdict([request([401])]))).toBe("environment");
    expect(classifyFailure(verdict([request([403, 429])]))).toBe("environment");
    expect(classifyFailure(verdict([request([401, 500])]))).toBe("flow");
    expect(classifyFailure(verdict([request([500, 401])]))).toBe("flow");
    expect(classifyFailure(verdict([request([401, 0, 500])]))).toBe("flow");
    expect(classifyFailure(verdict([request([401, 0])]))).toBe("flow"); // pending is not a refusal
    expect(classifyFailure(verdict([request([401]), red("navigated", {}, { to: "x" })]))).toBe("flow");
  });

  it("guards alone lean to the flow — a 500 is the same 500 whether a goal or a guard saw it", () => {
    expect(classifyFailure(verdict([ok("navigated"), guard([500])]))).toBe("flow");
    expect(classifyFailure(verdict([ok("navigated"), guard([429, 500, 500])]))).toBe("flow"); // every failure counts, not the first
    expect(classifyFailure(verdict([ok("navigated"), guard([429])]))).toBe("environment");
    expect(classifyFailure(verdict([ok("navigated"), red("no-console-errors")]))).toBe("flow");
    expect(classifyFailure(verdict([ok("navigated"), red("no-console-errors"), guard([429])]))).toBe("flow");
  });

  it("a judge that could not judge is the environment only when nothing else failed", () => {
    const flaky = red("expect", { reason: "judge-failed" }, { criterion: "x" });
    const unwired = red("custom", { reason: "no-handler" }, { name: "stock" });
    expect(classifyFailure(verdict([flaky]))).toBe("environment");
    expect(classifyFailure(verdict([unwired]))).toBe("environment");
    expect(classifyFailure(verdict([flaky, red("navigated", {}, { to: "x" })]))).toBe("flow");
    expect(classifyFailure(verdict([flaky, guard([500])]))).toBe("flow");
    expect(classifyFailure(verdict([unwired, guard([500])]))).toBe("flow");
    expect(classifyFailure(verdict([flaky, guard([429])]))).toBe("environment");
  });

  it("finalizeVerdict stamps the class on a red and never on a green; a bare string is a blocked run", () => {
    expect(finalizeVerdict(verdict([ok("navigated")]))).not.toHaveProperty("failure");
    expect(finalizeVerdict(verdict([ok("navigated")]), "step 2/2 blocked: …")).toMatchObject({ failClosed: "blocked", failure: "script" });
    expect(finalizeVerdict(verdict([ok("navigated")]), "step 2/2 blocked: …", blockedBy("transport")).failure).toBe("environment");
    expect(finalizeVerdict(verdict([ok("navigated")]), { kind: "truncated", reason: "ended before done" })).toMatchObject({ failClosed: "truncated", failure: "script" });
    expect(finalizeVerdict(verdict([red("navigated", {}, { to: "x" })])).failure).toBe("flow");
  });
});

describe("the signals are set where they are known (#212)", () => {
  const ev = (requests: Evidence["logic"]["requests"], console: Evidence["logic"]["console"] = []): Evidence =>
    ({ execution: { actions: [], navigated: true, finalUrl: "https://shop.co/", blocked: false }, perception: {}, logic: { requests, console } });
  const orders = (status: number) => ({ method: "POST", url: "https://shop.co/api/orders", status });

  it("the request-status critic reports every status it saw, and the classifier reads that, not the text", () => {
    const r = checkAssertion({ kind: "request-status", urlIncludes: "/api/orders", status: 200 }, ev([orders(401), orders(0), orders(500)]));
    expect(r.statuses).toEqual([401, 0, 500]);
    expect(r.detail).toBe("expected 200, got 401, 0, 500 for https://shop.co/api/orders");
    expect(classifyFailure({ passed: false, results: [r] })).toBe("flow");
  });

  it("the failed-requests guard reports every failure, though its text names only the first", () => {
    const r = checkAssertion({ kind: "no-failed-requests" }, ev([orders(429), orders(500), orders(500)]));
    expect(r.statuses).toEqual([429, 500]);
    expect(r.detail).toMatch(/^3 failed request\(s\): 429 /);
    expect(classifyFailure({ passed: false, results: [r] })).toBe("flow");
  });

  it("a console line that looks like an engine message is page output — the guard carries no reason", () => {
    const r = checkAssertion({ kind: "no-console-errors" }, ev([], [{ type: "error", text: "Widget needs a registered handler" }]));
    expect(r.reason).toBeUndefined();
    expect(classifyFailure({ passed: false, results: [r] })).toBe("flow");
  });

  it("a check nobody can judge says so", () => {
    expect(checkAssertion({ kind: "custom", name: "stock" }, ev([])).reason).toBe("no-handler");
    expect(checkAssertion({ kind: "expect", criterion: "x" }, ev([])).reason).toBe("no-handler");
  });

  it("a judge whose LLM fails says so", async () => {
    const critic = new LlmCritic({ id: "dead", complete: async () => { throw new Error("Anthropic API 429"); } });
    const v = await critic.judge(ev([]), [{ kind: "expect", criterion: "x" }]);
    expect(v.results[0]).toMatchObject({ passed: false, reason: "judge-failed" });
    expect(v.failure).toBeUndefined(); // the critic judges; the finalizer names
  });

  it("toVerdict says why it failed closed", () => {
    expect(toVerdict([])).toMatchObject({ passed: false, failClosed: "no-assertions" });
    expect(toVerdict([{ assertion: { kind: "navigated", vacuous: true }, passed: true }])).toMatchObject({ passed: false, failClosed: "all-vacuous" });
    expect(toVerdict([{ assertion: { kind: "navigated" }, passed: true }])).not.toHaveProperty("failClosed");
  });

  it("the Chrome driver types its own MCP envelope by its own vocabulary, never by page text", () => {
    const kind = (text: string) => errorKindOf(mcpToolError("click", text));
    expect(kind("Protocol error (Runtime.callFunctionOn): Target closed")).toBe("transport");
    expect(kind("Session closed. Most likely the page has been closed.")).toBe("transport");
    expect(kind("Could not find Chrome (ver. 131). This can occur if…")).toBe("transport");
    expect(kind("Could not connect to Chrome at http://127.0.0.1:9222\nCause: connect ECONNREFUSED")).toBe("transport");
    expect(kind("Failed to interact with the element with uid 1_3. The element did not become interactive within the configured timeout.")).toBeUndefined();
    expect(kind("Node is either not clickable or not an Element")).toBeUndefined();
    expect(kind("Protocol error (Runtime.callFunctionOn): Cannot find context with specified id")).toBeUndefined(); // the app navigated mid-call: not the machine
    expect(kind('# Open dialog\nconfirm: "Target closed — continue?"\n\nError: Element with uid 1_3 no longer exists on the page.')).toBeUndefined();
  });

  it("stepError carries its kind structurally, so a driver outside this package can throw one", () => {
    const err = stepError("transport", "browser session ended");
    expect(err).toBeInstanceOf(Error);
    expect(errorKindOf(err)).toBe("transport");
    expect(errorKindOf(Object.assign(new Error("x"), { kind: "resolution" }))).toBe("resolution");
    expect(errorKindOf(new Error("no element matching Transport options"))).toBeUndefined();
    expect(errorKindOf(Object.assign(new Error("x"), { kind: "bogus" }))).toBeUndefined();
    expect(errorKindOf(null)).toBeUndefined();
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

  it("a replay whose step cannot resolve its target is a stale script, typed by the driver", async () => {
    const { result } = await runScenario(scenario, { driver: new FakeDriver({ evidence, failOn: ["Buy"] }), reporter: silent });
    expect(result.evidence.execution.actions[1]).toMatchObject({ ok: false, errorKind: "resolution" });
    expect(result.verdict).toMatchObject({ passed: false, failClosed: "blocked", failure: "script" });
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
