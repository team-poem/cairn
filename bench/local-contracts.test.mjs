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
