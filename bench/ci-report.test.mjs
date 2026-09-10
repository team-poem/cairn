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
