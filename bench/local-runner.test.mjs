// file: bench/local-runner.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const commit = "a".repeat(40);
const fixtureHash = "b".repeat(64);
const canonical = { name: "navigation", steps: [{ kind: "goto", url: "http://127.0.0.1:9000/" }, { kind: "click", target: { role: "link", text: "Continue" } }], assertions: [{ kind: "navigated", to: "http://127.0.0.1:9000/done" }] };
const zeroUsage = { llmCalls: 0, measuredCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
const arrivalProof = { grade: "arrival", discriminating: 1, vacuous: 0, work: 0, arrival: 1, guards: 0 };
const success = () => ({ result: { evidence: { execution: { blocked: false } }, verdict: { passed: true, proof: { ...arrivalProof }, results: [] }, usage: { ...zeroUsage } }, heals: [], stepHeals: [] });
async function harness(t, patch = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cairn local runner "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "navigation.skill.json");
  const bytes = JSON.stringify(canonical);
  await writeFile(path, bytes);
  await writeFile(path + ".meta.json", JSON.stringify({ tier: "navigation", fixtureVersion: "v1", fixtureHash, captureOrigin: "http://127.0.0.1:9000", scenarioHash: sha(bytes), source: { kind: "scripted", label: "offline smoke" }, engine: { version: "2.8.0", commit } }));
  const events = [];
  const options = [];
  let servers = 0, drivers = 0;
  const runtime = {
    engine: { version: "2.8.0", commit, dirty: false, buildHash: "c".repeat(64) },
    fixtureInfo: () => ({ hash: fixtureHash, entryPath: "/", intent: "Reach the destination" }),
    async startFixture(config) { const id = ++servers; events.push(`server:${id}`); return { origin: `http://127.0.0.1:${10000 + id}`, snapshot: () => ({ complete: true }), requestLog: () => [], async close() { events.push(`server-close:${id}`); } }; },
    createDriver() { const id = ++drivers; events.push(`driver:${id}`); return { id, async close() { events.push(`driver-close:${id}`); } }; },
    async runScenario(scenario, opts) { events.push(`run:${opts.driver.id}`); options.push({ scenario: structuredClone(scenario), opts }); return success(); },
    async discover() { throw new Error("Unexpected discovery"); },
    createLlm() { throw new Error("Unexpected LLM backend creation"); },
    async saveSkillFile(file, value) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2)); },
  };
  const config = { mode: "replay", tiers: ["navigation"], runs: 2, fixtureVersion: "v1", latency: { document: [0], api: [0, 30] }, engineCommit: commit, captureDir: dir, outputDir: join(dir, "results"), ...patch };
  return { dir, path, bytes, config, runtime, events, options };
}

test("localReplayOwnsEachRun: fresh server browser and canonical origin mapping surround every replay", async (t) => {
  const { runBenchmark } = await import("./local/runner.mjs");
  const h = await harness(t);
  const report = await runBenchmark(h.config, h.runtime);
  assert.deepEqual(h.events, ["server:1", "driver:1", "run:1", "driver-close:1", "server-close:1", "server:2", "driver:2", "run:2", "driver-close:2", "server-close:2"]);
  assert.deepEqual(h.options.map((r) => r.opts.replayEnvironment), [{ baseUrl: "http://127.0.0.1:10001", allowedHosts: ["127.0.0.1:9000"] }, { baseUrl: "http://127.0.0.1:10002", allowedHosts: ["127.0.0.1:9000"] }]);
  assert.ok(h.options.every((r) => r.opts.heal === false && typeof r.opts.llm.complete === "function"));
  assert.ok(h.options.every((r) => JSON.stringify(r.scenario) === h.bytes));
  assert.equal(await readFile(h.path, "utf8"), h.bytes);
  assert.equal(report.requested, 2);
  assert.equal(report.attempted, 2);
  assert.equal(report.completed, 2);
  assert.equal(report.incomplete, false);
  assert.ok(report.records.every((r) => r.passed && r.usage.llmCalls === 0));
});

test("localReplayRejectsLlmEvidence: attempted calls nonzero usage and unknown usage cannot be free successes", async (t) => {
  const { runBenchmark } = await import("./local/runner.mjs");
  const h = await harness(t, { runs: 3 });
  let call = 0;
  h.runtime.runScenario = async (_scenario, opts) => {
    call++;
    if (call === 1) await opts.llm.complete("must never reach a provider");
    const out = success();
    if (call === 2) out.result.usage.llmCalls = 1;
    if (call === 3) delete out.result.usage;
    return out;
  };
  const report = await runBenchmark(h.config, h.runtime);
  assert.equal(report.attempted, 3);
  assert.ok(report.records.every((r) => r.passed === false));
  assert.match(report.records[0].error.message, /LLM/i);
  assert.equal(report.records[1].usage.llmCalls, 1);
  assert.equal(report.records[2].usage, null);
  assert.equal(report.summaries[0].failures, 3);
});

test("localOracleAndEngineRemainSeparate: false greens blocked journeys and verdict failures remain observable", async (t) => {
  const { runBenchmark } = await import("./local/runner.mjs");
  const h = await harness(t, { runs: 3 });
  let index = 0;
  const start = h.runtime.startFixture;
  h.runtime.startFixture = async (opts) => { const fixture = await start(opts); const i = index++; fixture.snapshot = () => ({ complete: i !== 0 }); return fixture; };
  let run = 0;
  h.runtime.runScenario = async () => { const out = success(); if (run === 1) out.result.evidence.execution.blocked = true; if (run === 2) out.result.verdict = { passed: false, failure: "flow", results: [] }; run++; return out; };
  const report = await runBenchmark(h.config, h.runtime);
  assert.deepEqual(report.records.map((r) => r.passed), [false, false, false]);
  assert.equal(report.records[0].verdict, true);
  assert.equal(report.records[0].oracle.complete, false);
  assert.equal(report.records[1].journey, false);
  assert.equal(report.records[2].failure, "flow");
  assert.deepEqual(report.records[0].proof, arrivalProof);
  assert.equal(report.records[2].proof, null);
  assert.equal(report.summaries[0].failureRate, 1);
  assert.equal(report.completed, 3);
});

test("localFailuresKeepDenominators: driver setup and engine exceptions are recorded and all acquired resources close", async (t) => {
  const { runBenchmark } = await import("./local/runner.mjs");
  const h = await harness(t, { runs: 3 });
  const make = h.runtime.createDriver;
  let created = 0, ran = 0;
  h.runtime.createDriver = () => { if (++created === 1) throw new Error("driver setup failed"); return make(); };
  h.runtime.runScenario = async () => { if (++ran === 1) throw new Error("engine crashed"); return success(); };
  const report = await runBenchmark(h.config, h.runtime);
  assert.equal(report.requested, 3);
  assert.equal(report.attempted, 3);
  assert.equal(report.completed, 1);
  assert.equal(report.summaries[0].failures, 2);
  assert.equal(report.summaries[0].failureRate, 2 / 3);
  assert.match(report.records[0].error.message, /driver setup failed/);
  assert.match(report.records[1].error.message, /engine crashed/);
  assert.equal(h.events.filter((e) => e.startsWith("server-close:")).length, 3);
  assert.equal(h.events.filter((e) => e.startsWith("driver-close:")).length, 2);
  const cleanup = await harness(t, { runs: 2 });
  const start = cleanup.runtime.startFixture;
  cleanup.runtime.startFixture = async (opts) => { const fixture = await start(opts); fixture.close = async () => { throw new Error("server cleanup failed"); }; return fixture; };
  const stopped = await runBenchmark(cleanup.config, cleanup.runtime);
  assert.equal(stopped.attempted, 1);
  assert.equal(stopped.incomplete, true);
  assert.equal(stopped.records[0].passed, false);
  assert.match(stopped.records[0].error.message, /server cleanup failed/);
});

test("localHealingAttemptsAreIndependent: v2 attempts reuse the original freeze and distinguish survival from repair counts", async (t) => {
  const { runBenchmark } = await import("./local/runner.mjs");
  const h = await harness(t, { mode: "heal", fixtureVersion: "v2", llm: { source: "scripted", label: "offline smoke" } });
  h.runtime.createLlm = () => ({ id: "scripted", async complete() { return "unused"; } });
  h.runtime.fixtureInfo = (_tier, version) => ({ hash: version === "v2" ? "d".repeat(64) : fixtureHash, entryPath: "/", intent: "Reach the destination" });
  const inputs = [];
  const versions = [];
  const start = h.runtime.startFixture;
  h.runtime.startFixture = (opts) => { versions.push(opts.version); return start(opts); };
  h.runtime.runScenario = async (scenario, opts) => { inputs.push(structuredClone(scenario)); assert.equal(opts.heal, true); scenario.name = "mutated by stub"; return { ...success(), healedScenario: { ...canonical, name: "healed replacement" } }; };
  const report = await runBenchmark(h.config, h.runtime);
  assert.deepEqual(inputs, [canonical, canonical]);
  assert.deepEqual(versions, ["v2", "v2"]);
  assert.equal(await readFile(h.path, "utf8"), h.bytes);
  assert.ok(report.records.every((r) => r.mode === "heal" && r.passed && r.healCount === 0));
  assert.ok(report.records.every((r) => r.fixtureHash === "d".repeat(64)));
  assert.equal(report.summaries[0].mode, "heal");
});

test("localDiscoveryHasItsOwnAttempts: failed discoveries remain counted and successful captures preserve their explicit source", async (t) => {
  const { runBenchmark } = await import("./local/runner.mjs");
  const h = await harness(t, { mode: "discover", runs: 5, llm: { source: "scripted", label: "offline smoke" } });
  h.runtime.createLlm = () => ({ id: "scripted", async complete() { return "unused"; } });
  h.runtime.runScenario = async () => { throw new Error("Discovery must not silently become replay"); };
  let calls = 0;
  const start = h.runtime.startFixture;
  h.runtime.startFixture = async (opts) => { const fixture = await start(opts); fixture.snapshot = () => ({ complete: calls !== 4 }); return fixture; };
  h.runtime.discover = async (_intent, opts) => { assert.equal(opts.semanticChecks, false); if (++calls === 2) throw new Error("discovery failed"); return { ...canonical, ...(calls === 3 ? { truncated: true } : {}), steps: [{ kind: "goto", url: opts.baseUrl + "/" }, canonical.steps[1]], assertions: [{ kind: "navigated", to: opts.baseUrl + "/done" }] }; };
  const report = await runBenchmark(h.config, h.runtime);
  assert.equal(calls, 5);
  assert.equal(report.requested, 5);
  assert.equal(report.attempted, 5);
  assert.equal(report.completed, 4);
  assert.equal(report.summaries[0].failures, 3);
  assert.equal(report.summaries[0].failureRate, 3 / 5);
  assert.deepEqual(report.records.map((r) => r.passed), [true, false, false, false, true]);
  assert.ok(report.records.slice(1, 4).every((r) => !r.artifactPath));
  for (const record of report.records.filter((r) => r.artifactPath)) {
    const sidecar = JSON.parse(await readFile(record.artifactPath + ".meta.json", "utf8"));
    assert.equal(sidecar.source.kind, "scripted");
    assert.equal(sidecar.source.label, "offline smoke");
    assert.equal(sidecar.scenarioHash, sha(await readFile(record.artifactPath, "utf8")));
    assert.equal(record.scenarioHash, sidecar.scenarioHash);
    assert.equal(record.verdict, null);
  }
  assert.equal(report.records.filter((r) => r.artifactPath).length, 2);
  assert.equal(new Set(report.records.filter((r) => r.artifactPath).map((r) => r.artifactPath)).size, 2);
});

test("localPreflightAndAbortAreExplicit: incompatible inputs do no browser work and interrupted measurements remain incomplete", async (t) => {
  const { runBenchmark } = await import("./local/runner.mjs");
  const h = await harness(t, { runs: 3 });
  for (const patch of [{ runs: 0 }, { engineCommit: "d".repeat(40) }, { captureDir: join(h.dir, "missing") }]) {
    await assert.rejects(runBenchmark({ ...h.config, ...patch }, h.runtime));
    assert.deepEqual(h.events, []);
  }
  const controller = new AbortController();
  h.runtime.runScenario = async () => { controller.abort(); return success(); };
  const report = await runBenchmark({ ...h.config, signal: controller.signal }, h.runtime);
  assert.equal(report.requested, 3);
  assert.equal(report.attempted, 1);
  assert.equal(report.completed, 1);
  assert.equal(report.incomplete, true);
  assert.match(report.stopReason, /abort/i);
  assert.deepEqual(h.events.filter((e) => e.includes("close")), ["driver-close:1", "server-close:1"]);
});

test("localReportsRetainProvenance: JSON is authoritative and its table preserves failures counts hashes and actual timestamps", async (t) => {
  const { runBenchmark } = await import("./local/runner.mjs");
  const { writeReport, renderMarkdown } = await import("./local/report.mjs");
  const h = await harness(t, { runs: 2 });
  h.runtime.runScenario = async () => { throw new Error("all attempts fail"); };
  const start = Date.now();
  const report = await runBenchmark(h.config, h.runtime);
  assert.deepEqual(report.engine, h.runtime.engine);
  assert.match(report.configHash, /^[a-f0-9]{64}$/);
  assert.ok(Date.parse(report.startedAt) >= start);
  assert.ok(Date.parse(report.finishedAt) >= Date.parse(report.startedAt));
  assert.ok(report.runtime.node && report.runtime.platform);
  assert.ok(report.records.every((r) => r.scenarioHash === sha(h.bytes) && r.fixtureHash === fixtureHash && Number.isFinite(r.elapsedMs) && r.elapsedMs >= 0));
  assert.deepEqual(report.records.map((r) => r.requestedDelays), [{ document: 0, api: 0 }, { document: 0, api: 30 }]);
  const paths = await writeReport(report, h.config.outputDir);
  const saved = JSON.parse(await readFile(paths.json, "utf8"));
  assert.deepEqual(saved, report);
  const markdown = await readFile(paths.markdown, "utf8");
  assert.equal(markdown, renderMarkdown(saved));
  assert.match(markdown, /navigation/);
  assert.match(markdown, /replay/);
  assert.match(markdown, /100(?:\.0+)?%/);
  assert.doesNotMatch(markdown, /reliable|deterministic success/i);
  assert.equal(saved.summaries[0].requested, 2);
  assert.equal(saved.summaries[0].attempted, 2);
  assert.equal(saved.summaries[0].completed, 0);
  assert.equal(saved.summaries[0].failures, 2);
});

test("localPaidSequenceHonorsSharedBudget: unknown cost thresholds and hard call counts stop later attempts across the invocation", async (t) => {
  const { runBenchmark } = await import("./local/runner.mjs");
  for (const limits of [{ maxCalls: 3, maxCostUsd: 0.01, costUsd: 0.02, attempted: 1 }, { maxCalls: 3, maxCostUsd: 1, costUsd: null, attempted: 1 }, { maxCalls: 2, maxCostUsd: 1, costUsd: 0, attempted: 2 }]) {
    const h = await harness(t, { mode: "discover", runs: 3, llm: { source: "llm", backend: "test-backend", model: "test-model", maxCalls: limits.maxCalls, maxCostUsd: limits.maxCostUsd } });
    const budgets = [];
    h.runtime.createLlm = (_config, { budget }) => {
      budgets.push(budget);
      return { id: "test-backend", async complete() { budget.reserve(); budget.record({ costUsd: limits.costUsd }); return "done"; } };
    };
    h.runtime.discover = async (_intent, opts) => { await opts.llm.complete("offline provider stub"); return { ...canonical, steps: [{ kind: "goto", url: opts.baseUrl + "/" }, canonical.steps[1]], assertions: [{ kind: "navigated", to: opts.baseUrl + "/done" }] }; };
    const report = await runBenchmark(h.config, h.runtime);
    assert.equal(report.requested, 3);
    assert.equal(report.attempted, limits.attempted);
    assert.equal(report.incomplete, true);
    assert.equal(new Set(budgets).size, 1);
    assert.equal(report.budget.calls, limits.attempted);
    assert.equal(report.records.length, limits.attempted);
    assert.equal(report.summaries[0].requested, 3);
    assert.equal(report.summaries[0].attempted, limits.attempted);
    assert.ok(report.stopReason);
    assert.equal(report.budget.measuredCostUsd, (limits.costUsd ?? 0) * limits.attempted);
    assert.equal(report.budget.costComplete, limits.costUsd !== null);
    assert.equal(h.events.filter((e) => e.startsWith("server:")).length, limits.attempted);
    assert.equal(h.events.filter((e) => e.startsWith("server-close:")).length, limits.attempted);
  }
});

test("localTierSummariesDoNotDropWork: every selected tier retains its own attempts failures and artifact identity", async (t) => {
  const { runBenchmark } = await import("./local/runner.mjs");
  const h = await harness(t, { tiers: ["navigation", "form", "stateful"], runs: 2 });
  const hashes = { navigation: fixtureHash, form: "d".repeat(64), stateful: "e".repeat(64) };
  h.runtime.fixtureInfo = (tier) => ({ hash: hashes[tier], entryPath: "/", intent: tier });
  for (const tier of ["form", "stateful"]) {
    const path = join(h.dir, tier + ".skill.json");
    const bytes = JSON.stringify({ ...canonical, name: tier });
    await writeFile(path, bytes);
    await writeFile(path + ".meta.json", JSON.stringify({ tier, fixtureVersion: "v1", fixtureHash: hashes[tier], captureOrigin: "http://127.0.0.1:9000", scenarioHash: sha(bytes), source: { kind: "scripted", label: "offline smoke" }, engine: { version: "2.8.0", commit } }));
  }
  h.runtime.runScenario = async (scenario) => { if (scenario.name === "form") throw new Error("form failed"); return success(); };
  const report = await runBenchmark(h.config, h.runtime);
  assert.equal(report.requested, 6);
  assert.equal(report.attempted, 6);
  assert.equal(report.completed, 4);
  assert.deepEqual(report.summaries.map((s) => [s.tier, s.requested, s.attempted, s.failures, s.failureRate]), [["navigation", 2, 2, 0, 0], ["form", 2, 2, 2, 1], ["stateful", 2, 2, 0, 0]]);
  assert.ok(report.records.every((r) => r.fixtureHash === hashes[r.tier]));
});

test("localFinalAbortPersistsIncompleteReport: an aborted only attempt remains incomplete in saved JSON and Markdown", async (t) => {
  const { runBenchmark } = await import("./local/runner.mjs");
  const { writeReport } = await import("./local/report.mjs");
  const h = await harness(t, { runs: 1 });
  const controller = new AbortController();
  h.runtime.runScenario = async () => { controller.abort(); controller.signal.throwIfAborted(); };
  const report = await runBenchmark({ ...h.config, signal: controller.signal }, h.runtime);
  const paths = await writeReport(report, h.config.outputDir);
  const saved = JSON.parse(await readFile(paths.json, "utf8"));
  const markdown = await readFile(paths.markdown, "utf8");
  assert.equal(saved.requested, 1);
  assert.equal(saved.attempted, 1);
  assert.equal(saved.completed, 0);
  assert.equal(saved.records.length, 1);
  assert.equal(saved.records[0].error.name, "AbortError");
  assert.equal(saved.summaries[0].failures, 1);
  assert.deepEqual(h.events, ["server:1", "driver:1", "driver-close:1", "server-close:1"]);
  assert.equal(saved.incomplete, true);
  assert.match(saved.stopReason, /abort/i);
  assert.match(markdown, /INCOMPLETE:.*abort/i);
  assert.doesNotMatch(markdown, /Requested attempts completed\./);
});

test("localFinalCleanupAbortIsObserved: abort during awaited cleanup marks the last successful engine attempt incomplete", async (t) => {
  const { runBenchmark } = await import("./local/runner.mjs");
  const h = await harness(t, { runs: 1 });
  const controller = new AbortController();
  const create = h.runtime.createDriver;
  h.runtime.createDriver = () => {
    const driver = create();
    const close = driver.close;
    driver.close = async () => { await close(); await Promise.resolve(); controller.abort(); };
    return driver;
  };
  const report = await runBenchmark({ ...h.config, signal: controller.signal }, h.runtime);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(h.events, ["server:1", "driver:1", "run:1", "driver-close:1", "server-close:1"]);
  assert.equal(report.requested, 1);
  assert.equal(report.attempted, 1);
  assert.equal(report.completed, 1);
  assert.equal(report.records.length, 1);
  assert.equal(report.records[0].verdict, true);
  assert.equal(report.records[0].oracle.complete, true);
  assert.equal(report.records[0].usage.llmCalls, 0);
  assert.equal(report.incomplete, true);
  assert.match(report.stopReason, /abort/i);
});

test("localTerminalBudgetStopIsIncomplete: final call and cost limits remain visible after the requested engine attempts return", async (t) => {
  const { runBenchmark } = await import("./local/runner.mjs");
  for (const limits of [{ maxCalls: 1, maxCostUsd: 1 }, { maxCalls: 5, maxCostUsd: 0.01 }]) {
    const h = await harness(t, { mode: "heal", runs: 1, fixtureVersion: "v2", llm: { source: "llm", backend: "fake", model: "fake-model", ...limits } });
    h.runtime.createLlm = (_config, { budget }) => ({ id: "fake", async complete() { budget.reserve(); budget.record({ costUsd: 0.01 }); return "done"; } });
    h.runtime.runScenario = async (_scenario, options) => { await options.llm.complete("repair"); const output = success(); output.result.usage.llmCalls = 1; return output; };
    const report = await runBenchmark(h.config, h.runtime);
    assert.equal(report.requested, 1);
    assert.equal(report.attempted, 1);
    assert.equal(report.completed, 1);
    assert.equal(report.records.length, 1);
    assert.equal(report.records[0].passed, true);
    assert.equal(report.summaries[0].failures, 0);
    assert.equal(report.budget.calls, 1);
    assert.equal(report.budget.measuredCostUsd, 0.01);
    assert.equal(report.budget.costComplete, true);
    assert.match(report.budget.stopReason, /limit|threshold/i);
    assert.equal(report.incomplete, true);
    assert.equal(report.stopReason, report.budget.stopReason);
  }
});
