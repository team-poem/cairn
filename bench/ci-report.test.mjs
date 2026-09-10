// file: bench/ci-report.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { compareReports, renderComparison } from "./ci-report.mjs";

// compareReports returns {baseCommit, headCommit, sizes, tiers}; sizes maps each
// metric to {base, head, delta, percent}; tiers contains {tier, base, head,
// deltaMs, percent, status}. Each side contains {runs, failures, medianMs, p95Ms,
// llmCalls, observedLlmCalls}. status is improved/regressed/unchanged/invalid.
// Invalid identity, counts, incomplete input or non-finite measurements throw;
// measured failed/LLM-tainted attempts remain in statistics with invalid status.
function report(commit = "a".repeat(40)) {
  return {
    schemaVersion: 1, commit,
    environment: { node: "v20.20.0", chrome: "Chrome 140.0.0.0", platform: "linux", arch: "x64" },
    workload: { fixtureHash: "fixture-v1", captures: [{ tier: "navigation", scenarioHash: "navigation-v1" }, { tier: "form", scenarioHash: "form-v1" }], runs: 5 },
    sizes: { packageBytes: 1000, unpackedBytes: 4000, browserBytes: 2000, browserGzipBytes: 500 },
    records: ["navigation", "form"].flatMap(tier => [10, 20, 30, 40, 50].map(elapsedMs => ({ tier, elapsedMs, passed: true, llmCalls: 0, observedLlmCalls: 0 }))),
    incomplete: false,
  };
}
function pair() { return [report(), report("b".repeat(40))]; }

test("ciSizeDeltas: reports signed byte and percentage changes for every shipped size", () => {
  const [base, head] = pair();
  head.sizes = { packageBytes: 900, unpackedBytes: 4400, browserBytes: 2000, browserGzipBytes: 550 };
  const result = compareReports(base, head);
  assert.equal(result.baseCommit, base.commit);
  assert.equal(result.headCommit, head.commit);
  assert.deepEqual(result.sizes, {
    packageBytes: { base: 1000, head: 900, delta: -100, percent: -10 },
    unpackedBytes: { base: 4000, head: 4400, delta: 400, percent: 10 },
    browserBytes: { base: 2000, head: 2000, delta: 0, percent: 0 },
    browserGzipBytes: { base: 500, head: 550, delta: 50, percent: 10 },
  });
});

test("ciTierStatistics: keeps per-tier latency and failures separate and uses nearest-rank p95", () => {
  const [base, head] = pair();
  for (const row of head.records) row.elapsedMs *= row.tier === "navigation" ? 0.5 : 2;
  head.records.find(row => row.tier === "form").passed = false;
  const result = compareReports(base, head);
  const navigation = result.tiers.find(row => row.tier === "navigation");
  assert.deepEqual(navigation.base, { runs: 5, failures: 0, medianMs: 30, p95Ms: 50, llmCalls: 0, observedLlmCalls: 0 });
  assert.deepEqual(navigation.head, { runs: 5, failures: 0, medianMs: 15, p95Ms: 25, llmCalls: 0, observedLlmCalls: 0 });
  assert.equal(navigation.deltaMs, -15);
  assert.equal(navigation.percent, -50);
  assert.equal(navigation.status, "improved");
  const form = result.tiers.find(row => row.tier === "form");
  assert.equal(form.head.failures, 1);
  assert.equal(form.head.medianMs, 60);
  assert.equal(form.status, "invalid");
});

test("ciUnsafeSpeedup: failed or model-calling attempts never count as speed improvements", () => {
  for (const side of ["base", "head"]) {
    for (const fault of [{ passed: false }, { llmCalls: 1 }, { observedLlmCalls: 1 }]) {
      const [base, head] = pair();
      for (const row of head.records) row.elapsedMs /= 10;
      Object.assign((side === "base" ? base : head).records[0], fault);
      const navigation = compareReports(base, head).tiers.find(row => row.tier === "navigation");
      assert.equal(navigation.status, "invalid", `${side} ${JSON.stringify(fault)}`);
      assert.equal(navigation[side].llmCalls, fault.llmCalls ?? 0);
      assert.equal(navigation[side].observedLlmCalls, fault.observedLlmCalls ?? 0);
    }
  }
});

test("ciComparisonIdentity: rejects different runtime workload or canonical scenario identity", () => {
  const mutations = [
    head => head.schemaVersion = 2,
    ...["node", "chrome", "platform", "arch"].map(key => head => head.environment[key] += "-different"),
    head => head.workload.fixtureHash = "different-fixture",
    head => head.workload.captures[0].scenarioHash = "different-scenario",
    head => head.workload.captures[0].tier = "stateful",
    head => head.workload.runs = 4,
  ];
  for (const mutate of mutations) {
    const [base, head] = pair();
    mutate(head);
    assert.throws(() => compareReports(base, head));
  }
});

test("ciCompleteCounts: refuses incomplete missing duplicate or unexpected tier samples", () => {
  const mutations = [
    input => input.incomplete = true,
    input => input.records.pop(),
    input => input.records.push({ ...input.records[0] }),
    input => input.records[0].tier = "unexpected",
    input => input.workload.captures.push({ ...input.workload.captures[0] }),
    input => { input.workload.captures = []; input.records = []; },
  ];
  for (const side of ["base", "head"]) for (const mutate of mutations) {
    const [base, head] = pair();
    mutate(side === "base" ? base : head);
    assert.throws(() => compareReports(base, head));
  }
});
