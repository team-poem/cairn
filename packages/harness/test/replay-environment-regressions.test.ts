// file: packages/harness/test/replay-environment-regressions.test.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { runScenario } from "../src/run.js";
import { runSuite, hashCase } from "../src/suite.js";
import { reanchorScenario } from "../src/core/replay-environment.js";
import { urlMatchesFrozen } from "../src/core/requests.js";
import { renderSuiteReport } from "../src/adapters/reporters/suite.js";
import { StubDriver } from "./support/doubles.js";
import type { Scenario } from "../src/core/types.js";
import type { SuiteResult } from "../src/suite.js";
const environment = { baseUrl: "http://localhost:3000", allowedHosts: ["stage.test", "api.stage.test"] };
const reporter = { emit: async () => {} };
const rootScenario = (): Scenario => ({ name: "root", steps: [{ kind: "goto", url: "https://stage.test/" }], assertions: [{ kind: "navigated", to: "stage.test" }] });

test("replayRootPageExpectations: frozen root destinations agree across expect waitFor and final verdict", async () => {
  for (const key of ["stage.test", "https://stage.test", "stage.test/", "https://stage.test/"]) {
    const scenario: Scenario = { ...rootScenario(), steps: [
      { kind: "goto", url: "https://stage.test/", expect: { url: key } },
      { kind: "waitFor", until: { url: key }, timeoutMs: 1 }], assertions: [{ kind: "navigated", to: key }] };
    const original = JSON.stringify(scenario); const driver = new StubDriver();
    const complete = vi.fn(async () => { throw new Error("LLM forbidden"); });
    const { result } = await runScenario(scenario, { driver, reporter, replayEnvironment: environment, expectTimeoutMs: 1, llm: { id: "forbidden", complete } });
    expect(result.verdict.passed, key).toBe(true); expect(result.evidence.execution.finalUrl).toBe("http://localhost:3000/");
    expect(result.usage?.llmCalls).toBe(0); expect(complete).not.toHaveBeenCalled(); expect(JSON.stringify(scenario)).toBe(original);
  }
});

test("reanchorRootPageForms: page roots reanchor without loosening host-only API requests", () => {
  for (const [source, target] of [
    ["stage.test", "localhost:3000"], ["https://stage.test", "http://localhost:3000"],
    ["stage.test/", "localhost:3000/"], ["https://stage.test/", "http://localhost:3000/"],
    ["stage.test?lang=en#top", "localhost:3000?lang=en#top"],
  ]) {
    const requestStatus = { urlIncludes: "api.stage.test/", status: 200 };
    const scenario: Scenario = { name: "root", steps: [{ kind: "waitFor", until: { url: source, requestStatus }, expect: { url: source } }], assertions: [{ kind: "navigated", to: source }, { kind: "request-status", ...requestStatus }] };
    const mapped = reanchorScenario(scenario, environment);
    expect(mapped.steps[0]).toEqual({ kind: "waitFor", until: { url: target, requestStatus }, expect: { url: target } });
    expect(mapped.assertions[0]).toEqual({ kind: "navigated", to: target }); expect(mapped.assertions[1]).toBe(scenario.assertions[1]);
  }
  for (const frozen of ["api.stage.test", "api.stage.test/", "api.stage.test/?op=Save"]) {
    expect(urlMatchesFrozen("http://localhost:3000/?op=Save", frozen, { allowedHosts: [...environment.allowedHosts, "localhost:3000"] })).toBe(false);
  }
});

test("replayEntryScopePreflight: reject an unlisted first goto before any action and allow exact target entry", async () => {
  for (const entry of ["https://production.test/start", "https://localhost:3000/start", "http://localhost:3001/start"]) {
    const driver = new StubDriver(); const goto = vi.spyOn(driver, "goto"); const observe = vi.spyOn(driver, "observe");
    const action = vi.fn(async () => {}); const complete = vi.fn(async () => "[]");
    const scenario: Scenario = { ...rootScenario(), steps: [{ kind: "custom", name: "before" }, { kind: "goto", url: entry }] };
    await expect(runScenario(scenario, { driver, reporter, replayEnvironment: environment, actions: { before: action }, llm: { id: "forbidden", complete } })).rejects.toThrow(/entry|allowedHosts/);
    expect(goto).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  }
  const driver = new StubDriver(); const goto = vi.spyOn(driver, "goto");
  const scenario: Scenario = { name: "external later", steps: [{ kind: "goto", url: "http://localhost:3000/start" }, { kind: "goto", url: "https://pay.test/checkout" }], assertions: [{ kind: "navigated", to: "pay.test/checkout" }] };
  expect((await runScenario(scenario, { driver, reporter, replayEnvironment: environment })).result.verdict.passed).toBe(true);
  expect(goto.mock.calls).toEqual([["http://localhost:3000/start"], ["https://pay.test/checkout"]]);
  expect((await runScenario({ ...rootScenario(), steps: [] }, { driver: new StubDriver("http://localhost:3000/"), reporter, replayEnvironment: environment })).result.verdict.passed).toBe(true);
  const c = { id: "invalid", intent: "invalid", url: "https://production.test/start" };
  const frozen: Scenario = { ...rootScenario(), steps: [{ kind: "goto", url: c.url }] };
  const driverFactory = vi.fn(() => new StubDriver());
  const suite = await runSuite([c], { replayEnvironment: environment, reporter, driverFactory, heal: false, store: { load: async () => ({ ...frozen, caseHash: hashCase(c) }), freeze: vi.fn(async (ref: string) => ref) } });
  expect(driverFactory).not.toHaveBeenCalled(); expect(suite.verdicts[0]?.notRun).toBe("invalid-entry");
  expect(suite.verdicts[0]?.verdict.failure).toBe("script");
});

test("suiteCacheMissNotRun: missing and stale caches are nonexecutions, not free replays", async () => {
  const cases = ["missing", "stale", "cached"].map((id) => ({ id, intent: "root", url: "https://stage.test/" }));
  const cached = { ...rootScenario(), caseHash: hashCase(cases[2]!) };
  const driverFactory = vi.fn(() => new StubDriver()); const freeze = vi.fn(async (ref: string) => ref);
  const suite = await runSuite(cases, { reporter, replayEnvironment: environment, driverFactory, heal: false, store: {
    load: async (ref) => { if (ref.includes("missing")) throw new Error("missing"); return ref.includes("stale") ? { ...cached, caseHash: "old" } : cached; }, freeze,
  } });
  expect(suite.verdicts.map((v) => v.notRun)).toEqual(["cache-miss", "cache-miss", undefined]);
  expect(driverFactory).toHaveBeenCalledOnce(); expect(freeze).not.toHaveBeenCalled();
  const report = renderSuiteReport(suite);
  expect(report).toContain("1 case(s) replayed with zero LLM calls");
  expect(report).toContain("| missing | ✗ fail | not run (cache miss)");
  expect(report).toContain("| stale | ✗ fail | not run (cache miss)");
  expect(report).toContain("| cached | ✓ pass | replayed (cached)");
});

test("cliCacheMissNotRun: CLI progress report and JSON name the cache refusal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cairn-cache-refusal-"));
  const cases = join(dir, "cases.json"); const json = join(dir, "result.json");
  try {
    await writeFile(cases, JSON.stringify([{ id: "missing", intent: "root", url: "https://stage.test/" }]));
    const execute = promisify(execFile);
    const result = await execute(process.execPath, ["--import", "tsx", "src/cli.ts", "suite", cases, "--skills", join(dir, "skills"), "--replay-base-url", environment.baseUrl, "--allowed-hosts", "stage.test", "--json", json], { cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 10_000 }).then(
      (r) => ({ code: 0, ...r }),
      (error: { code: number; stdout: string; stderr: string }) => error,
    );
    expect(result.code).toBe(3); expect(result.stdout).toContain("missing — not run (cache miss)");
    expect(result.stdout).not.toContain("case(s) replayed with zero LLM calls");
    expect((JSON.parse(await readFile(json, "utf8")) as SuiteResult).verdicts[0]?.notRun).toBe("cache-miss");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
