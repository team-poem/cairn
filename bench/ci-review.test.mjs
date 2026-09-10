import test from "node:test";
import assert from "node:assert/strict";
import { compareReports, renderComparison } from "./ci-report.mjs";

function report(commit = "a".repeat(40)) {
  return {
    schemaVersion: 1, commit, incomplete: false,
    environment: { node: "v20", chrome: "153", platform: "linux", arch: "x64" },
    workload: { fixtureHash: "fixture", captures: ["navigation", "form", "stateful"].map(tier => ({ tier, scenarioHash: tier })), runs: 4 },
    sizes: { packageBytes: 100, unpackedBytes: 400, browserBytes: 200, browserGzipBytes: 50 },
    records: ["navigation", "form", "stateful"].flatMap(tier => [10, 20, 30, 40].map(elapsedMs => ({ tier, elapsedMs, passed: true, llmCalls: 0, observedLlmCalls: 0 }))),
  };
}

test("failed attempts with unknown usage retain elapsed data and leave other tiers comparable", () => {
  for (const field of ["llmCalls", "observedLlmCalls"]) {
    const base = report(), head = report("b".repeat(40));
    Object.assign(head.records[0], { passed: false, elapsedMs: 100, [field]: null });
    const result = compareReports(base, head);
    assert.equal(result.tiers[0].head.medianMs, 35);
    assert.equal(result.tiers[0].head.p95Ms, 100);
    assert.equal(result.tiers[0].head.failures, 1);
    assert.equal(result.tiers[0].head[field], null);
    assert.equal(result.tiers[0].status, "invalid");
    assert.equal(result.tiers[1].status, "unchanged");
    const markdown = renderComparison(result, { includeContext: false });
    assert.match(markdown, /unknown/);
    assert.doesNotMatch(markdown, /All measured attempts passed/);
  }
});

test("failed attempts still reject malformed usage instead of treating it as unknown", () => {
  for (const field of ["llmCalls", "observedLlmCalls"]) for (const invalid of [undefined, -1, "0", NaN, Infinity]) {
    const base = report(), head = report("b".repeat(40));
    Object.assign(head.records[0], { passed: false, [field]: invalid });
    assert.throws(() => compareReports(base, head), /Invalid CI measurement/);
  }
});

test("nearest-rank p95 excludes the maximum at twenty observations", () => {
  const base = report(), head = report("b".repeat(40));
  for (const input of [base, head]) {
    input.workload.runs = 20;
    input.records = input.workload.captures.flatMap(({ tier }) => Array.from({ length: 20 }, (_, i) => ({ tier, elapsedMs: i + 1, passed: true, llmCalls: 0, observedLlmCalls: 0 })));
  }
  for (const tier of compareReports(base, head).tiers) {
    assert.equal(tier.base.p95Ms, 19);
    assert.equal(tier.head.medianMs, 10.5);
  }
});

test("compact rendering preserves every table row from the full report", () => {
  const result = compareReports(report(), report("b".repeat(40)));
  const full = renderComparison(result), compact = renderComparison(result, { includeContext: false });
  const tables = markdown => markdown.split("\n").filter(line => line.startsWith("|"));
  assert.deepEqual(tables(compact), tables(full));
  assert.match(full, /Provenance/);
  assert.doesNotMatch(compact, /Provenance|Built JS SHA/);
});
