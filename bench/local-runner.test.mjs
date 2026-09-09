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
