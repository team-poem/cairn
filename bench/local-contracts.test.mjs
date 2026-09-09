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

test("localCapturesUseEngineSave: scenario bytes and separate provenance round-trip without wrapping or rewriting", async (t) => {
  const { saveCapture, loadCapture } = await import("./local/artifacts.mjs");
  const path = join(await directory(t), "navigation.skill.json");
  const calls = [];
  await saveCapture(path, canonical, metadata, async (file, value) => { calls.push({ file, value }); await saveSkillFile(file, value); });
  assert.deepEqual(calls, [{ file: path, value: canonical }]);
  const bytes = await readFile(path, "utf8");
  assert.deepEqual(JSON.parse(bytes), canonical);
  const sidecar = JSON.parse(await readFile(path + ".meta.json", "utf8"));
  assert.equal(sidecar.scenarioHash, sha(bytes));
  assert.deepEqual(sidecar.source, metadata.source);
  assert.equal(sidecar.fixtureHash, fixtureHash);
  const loaded = await loadCapture(path, { tier: "navigation", fixtureVersion: "v1", fixtureHash, mode: "replay" });
  assert.deepEqual(loaded.scenario, canonical);
  assert.equal(loaded.metadata.captureOrigin, metadata.captureOrigin);
  assert.equal(await readFile(path, "utf8"), bytes);
});

test("localCapturesRejectUntrustedInputs: missing malformed stale tampered and semantic replay captures fail closed", async (t) => {
  const { saveCapture, loadCapture } = await import("./local/artifacts.mjs");
  const path = join(await directory(t), "navigation.skill.json");
  const expected = { tier: "navigation", fixtureVersion: "v1", fixtureHash, mode: "replay" };
  await assert.rejects(loadCapture(path, expected));
  await saveCapture(path, canonical, metadata, saveSkillFile);
  for (const patch of [{ tier: "form" }, { fixtureVersion: "v2" }, { fixtureHash: "c".repeat(64) }]) await assert.rejects(loadCapture(path, { ...expected, ...patch }));
  await writeFile(path, JSON.stringify({ ...canonical, name: "tampered" }));
  await assert.rejects(loadCapture(path, expected));
  for (const scenario of [{ name: "malformed" }, { ...canonical, assertions: [{ kind: "expect", criterion: "looks right" }] }, { ...canonical, truncated: true }]) {
    await saveSkillFile(path, scenario);
    await writeFile(path + ".meta.json", JSON.stringify({ ...metadata, scenarioHash: sha(await readFile(path, "utf8")) }));
    await assert.rejects(loadCapture(path, expected));
  }
  await saveSkillFile(path, canonical);
  for (const source of [null, {}, { kind: "unidentified" }, { kind: "llm", backend: "", model: "" }]) {
    await writeFile(path + ".meta.json", JSON.stringify({ ...metadata, source, scenarioHash: sha(await readFile(path, "utf8")) }));
    await assert.rejects(loadCapture(path, expected));
  }
});

test("localBudgetCountsBeforeCalls: a shared call limit and measured threshold stop subsequent calls without hiding overshoot", async () => {
  const { createBudget } = await import("./local/budget.mjs");
  const calls = createBudget({ maxCalls: 1, maxCostUsd: 10 });
  calls.reserve();
  calls.record({ costUsd: 0 });
  assert.throws(() => calls.reserve());
  assert.equal(calls.snapshot().calls, 1);
  assert.equal(calls.snapshot().measuredCostUsd, 0);
  const cost = createBudget({ maxCalls: 5, maxCostUsd: 0.1 });
  cost.reserve();
  cost.record({ costUsd: 0.15 });
  assert.equal(cost.snapshot().measuredCostUsd, 0.15);
  assert.throws(() => cost.reserve());
  assert.equal(cost.snapshot().calls, 1);
  const failed = createBudget({ maxCalls: 2, maxCostUsd: 1 });
  failed.reserve();
  failed.record({ costUsd: 0.02, error: "provider failure" });
  assert.equal(failed.snapshot().calls, 1);
  assert.equal(failed.snapshot().measuredCostUsd, 0.02);
  assert.equal(failed.snapshot().costComplete, true);
  failed.reserve();
  assert.equal(failed.snapshot().calls, 2);
});
