import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { collectReplays, measuredRounds } from "./ci-sampling.mjs";
import { compareReports, renderComparison } from "./ci-report.mjs";
import { runBenchmark } from "./local/runner.mjs";
import { successful } from "./ci-worker.mjs";

function fixture(mutate = () => {}) {
  const environment = { node: process.version, chrome: "153", mcp: "1.3.0", platform: process.platform, arch: process.arch };
  const workload = { fixtureHash: "fixture", captures: ["navigation", "form", "stateful"].map(tier => ({ tier, scenarioHash: tier })), runs: measuredRounds };
  const reports = Object.fromEntries(["base", "head"].map(side => [side, {
    schemaVersion: 1, commit: (side === "base" ? "a" : "b").repeat(40), buildHash: "c".repeat(64),
    environment, workload, sizes: { packageBytes: 100, unpackedBytes: 400, browserBytes: 200, browserGzipBytes: 50 }, records: [], incomplete: false,
  }]));
  const calls = [];
  let slot = 0;
  const options = { environment, workload, reports, baseRoot: "base", headRoot: "head", captures: "/captures", fixtureInfo: tier => ({ hash: `fixture-${tier}` }),
    attempt: async (side, label, mode, captures) => {
      calls.push({ side, label, mode, captures });
      const elapsedMs = label.endsWith("warmup") ? 100000 : ++slot;
      const result = { failed: false, report: {
        engine: { commit: reports[side].commit, buildHash: reports[side].buildHash }, runtime: { ...environment }, incomplete: false,
        records: workload.captures.map(({ tier, scenarioHash }) => ({ tier, scenarioHash, fixtureHash: `fixture-${tier}`, elapsedMs, passed: true, engineUsage: { llmCalls: 0 }, observedUsage: { llmCalls: 0 } })),
      } };
      await mutate(result, { side, label });
      return result;
    },
  };
  return { options, calls, reports };
}

test("four rounds balance linear position drift and exclude warmups", async () => {
  const f = fixture();
  assert.deepEqual(await collectReplays(f.options), { failed: false, warmupFailed: false });
  assert.deepEqual(f.calls.filter(x => !x.label.endsWith("warmup")).map(x => x.side), ["base", "head", "head", "base", "base", "head", "head", "base"]);
  for (const row of compareReports(f.reports.base, f.reports.head).tiers) {
    assert.equal(row.base.runs, 4);
    assert.equal(row.head.runs, 4);
    assert.equal(row.base.medianMs, 4.5);
    assert.equal(row.deltaMs, 0);
  }
  assert.ok(f.calls.every(x => x.mode === "replay" && x.captures === "/captures"));
});

for (const [name, mutate] of [
  ["commit", result => { result.report.engine.commit = "d".repeat(40); }],
  ["build", result => { result.report.engine.buildHash = "d".repeat(64); }],
  ...["node", "chrome", "mcp", "platform", "arch"].map(key => [key, result => { result.report.runtime[key] += "-changed"; }]),
  ["capture", result => { result.report.records[0].scenarioHash = "changed"; }],
  ["fixture", result => { result.report.records[0].fixtureHash = "changed"; }],
]) test(`collector refuses mid-run ${name} drift`, async () => {
  const f = fixture((result, { label }) => { if (label === "head-2") mutate(result); });
  await assert.rejects(collectReplays(f.options), /changed during measurement/i);
});

test("nonzero worker exit with successful rows marks output incomplete", async () => {
  const f = fixture((result, { label }) => { if (label === "head-1") result.failed = true; });
  assert.deepEqual(await collectReplays(f.options), { failed: true, warmupFailed: false });
  assert.equal(f.reports.head.incomplete, true);
  assert.throws(() => compareReports(f.reports.base, f.reports.head), /incomplete/);
});

test("worker incomplete flag prevents a comparison even on a zero exit", async () => {
  const f = fixture((result, { label }) => { if (label === "head-1") result.report.incomplete = true; });
  await collectReplays(f.options);
  assert.throws(() => compareReports(f.reports.base, f.reports.head), /incomplete/);
});

test("failed warmup remains a failure when all measured attempts pass", async () => {
  const f = fixture((result, { label }) => { if (label === "head-warmup") { result.failed = true; result.report.records[0].passed = false; } });
  assert.deepEqual(await collectReplays(f.options), { failed: true, warmupFailed: true });
  assert.equal(f.reports.head.records.length, 12);
  assert.ok(f.reports.head.records.every(row => row.passed));
});

test("each attempt must contain each tier once even when total counts would balance", async () => {
  const f = fixture((result, { label }) => {
    if (label === "head-1") result.report.records[0] = { ...result.report.records[1] };
    if (label === "head-2") result.report.records[1] = { ...result.report.records[0] };
  });
  await assert.rejects(collectReplays(f.options), /tier|sample/i);
});

test("a thrown engine replay survives the worker-to-comparison path as an invalid measured attempt", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cairn-thrown-replay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let raw;
  const f = fixture(async (result, { label }) => {
    if (label !== "head-1") return;
    let call = 0;
    raw = await runBenchmark({
      mode: "replay", runs: 1, tiers: ["navigation", "form", "stateful"],
      fixtureVersion: "v1", latency: { document: [0], api: [0] },
      engineCommit: result.report.engine.commit, captureDir: directory, outputDir: join(directory, "out"),
    }, {
      engine: result.report.engine, info: f.options.environment, fixtureInfo: f.options.fixtureInfo,
      startFixture: async () => ({ origin: "http://127.0.0.1:9000", snapshot: () => ({ complete: true }), close: async () => {} }),
      createDriver: () => ({ close: async () => {} }),
      runScenario: async () => {
        if (++call === 1) throw new Error("Synthetic browser crash");
        return { result: { evidence: { execution: { blocked: false } }, verdict: { passed: true }, usage: { llmCalls: 0 } } };
      },
    });
    result.report = raw;
    result.failed = !successful(raw);
  });
  const bytes = JSON.stringify({ name: "journey", steps: [{ kind: "goto", url: "http://127.0.0.1:9000/" }], assertions: [{ kind: "navigated", to: "http://127.0.0.1:9000/" }] });
  const hash = createHash("sha256").update(bytes).digest("hex");
  for (const capture of f.options.workload.captures) {
    capture.scenarioHash = hash;
    const path = join(directory, `${capture.tier}.skill.json`);
    await writeFile(path, bytes);
    await writeFile(path + ".meta.json", JSON.stringify({ tier: capture.tier, fixtureVersion: "v1", fixtureHash: `fixture-${capture.tier}`, scenarioHash: hash, captureOrigin: "http://127.0.0.1:9000", source: { kind: "scripted", label: "offline" }, engine: { commit: f.reports.base.commit, version: "2.8.0" } }));
  }
  assert.deepEqual(await collectReplays(f.options), { failed: true, warmupFailed: false });
  assert.equal(raw.attempted, 3);
  assert.equal(raw.incomplete, false);
  assert.equal(raw.records[0].engineUsage, null);
  assert.equal(f.reports.head.records[0].elapsedMs, raw.records[0].elapsedMs);
  const comparison = compareReports(f.reports.base, f.reports.head);
  const navigation = comparison.tiers[0];
  assert.equal(navigation.status, "invalid");
  assert.equal(navigation.head.runs, 4);
  assert.equal(navigation.head.failures, 1);
  assert.equal(navigation.head.llmCalls, null);
  assert.equal(navigation.head.observedLlmCalls, 0);
  assert.notEqual(comparison.tiers[1].status, "invalid");
  const markdown = renderComparison(comparison, { includeContext: false });
  assert.match(markdown, /0 \/ unknown/);
  assert.doesNotMatch(markdown, /All measured attempts passed/);
});
