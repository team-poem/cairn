// file: bench/local-contracts.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const commit = "a".repeat(40);
const fixtureHash = "b".repeat(64);
const canonical = { name: "navigation", steps: [{ kind: "goto", url: "http://127.0.0.1:9000/" }, { kind: "click", target: { role: "link", text: "Continue" } }], assertions: [{ kind: "navigated", to: "http://127.0.0.1:9000/done" }] };
const metadata = { tier: "navigation", fixtureVersion: "v1", fixtureHash, captureOrigin: "http://127.0.0.1:9000", source: { kind: "scripted", label: "offline smoke" }, engine: { version: "2.8.0", commit } };
const replayConfig = { mode: "replay", tiers: ["navigation"], runs: 2, fixtureVersion: "v1", latency: { document: [0], api: [0, 30] }, engineCommit: commit, captureDir: "/unused", outputDir: "/unused-results" };
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), "cairn local contracts "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const saveSkillFile = async (path, scenario) => writeFile(path, JSON.stringify(scenario, null, 2));

test("localConfigurationRejectsInvalidWork: modes counts tiers and latency are validated before execution", async () => {
  const { validateConfig } = await import("./local/config.mjs");
  assert.equal(validateConfig(replayConfig).runs, 2);
  for (const patch of [{ mode: "unknown" }, { runs: 0 }, { runs: -1 }, { runs: 1.5 }, { runs: Infinity }, { runs: Number.MAX_SAFE_INTEGER + 1 }, { tiers: [] }, { tiers: ["navigation", "navigation"] }, { tiers: ["other"] }, { engineCommit: "" }, { latency: { document: [], api: [0] } }, { latency: { document: [0], api: [-1] } }, { latency: { document: [NaN], api: [0] } }, { latency: { document: [0], api: [2147483648] } }]) {
    assert.throws(() => validateConfig({ ...replayConfig, ...patch }), JSON.stringify(patch));
  }
  assert.equal(validateConfig({ ...replayConfig, runs: 1, latency: { document: [0], api: [0] } }).runs, 1);
});

test("localCliMakesModesAndLimitsExplicit: arguments preserve paths and paid modes require declared LLM limits", async () => {
  const { parseOptions, validateConfig } = await import("./local/config.mjs");
  const parsed = parseOptions(["replay", "--runs", "3", "--config", "/a path/config.json", "--captures", "/a path/freezes", "--out", "/a path/results", "--engine-commit", commit]);
  assert.equal(parsed.mode, "replay");
  assert.equal(parsed.runs, 3);
  assert.equal(parsed.configPath, "/a path/config.json");
  assert.equal(parsed.captureDir, "/a path/freezes");
  assert.equal(parsed.outputDir, "/a path/results");
  for (const args of [[], ["replay", "--runs"], ["replay", "--runs", "3x"], ["replay", "--surprise", "1"]]) assert.throws(() => parseOptions(args));
  for (const mode of ["discover", "heal"]) {
    assert.throws(() => validateConfig({ ...replayConfig, mode }));
    const llm = { source: "llm", backend: "test-backend", model: "test-model", maxCalls: 3, maxCostUsd: 1 };
    assert.equal(validateConfig({ ...replayConfig, mode, llm }).mode, mode);
    for (const patch of [{ maxCalls: 0 }, { maxCalls: 1.1 }, { maxCostUsd: 0 }, { maxCostUsd: Infinity }, { backend: "" }, { model: "" }]) assert.throws(() => validateConfig({ ...replayConfig, mode, llm: { ...llm, ...patch } }));
  }
});
