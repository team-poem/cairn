import { join } from "node:path";
import { validateConfig } from "./config.mjs";
import { loadCapture, sha256 } from "./artifacts.mjs";
import { delayFor } from "./server.mjs";

export async function runBenchmark(config, runtime) {
  validateConfig(config);
  if (config.engineCommit !== runtime.engine.commit) throw new Error("Built engine commit does not match the requested commit");
  const captures = new Map();
  for (const tier of config.tiers) captures.set(tier, await loadCapture(join(config.captureDir, `${tier}.skill.json`), { tier, fixtureVersion: "v1", fixtureHash: runtime.fixtureInfo(tier, "v1").hash, mode: config.mode }));
  const { signal, ...configuration } = config;
  const report = { schemaVersion: 1, engine: { ...runtime.engine }, configuration, configHash: sha256(JSON.stringify(configuration)), runtime: { node: process.version, platform: process.platform, arch: process.arch }, startedAt: new Date().toISOString(), finishedAt: null, requested: config.tiers.length * config.runs, attempted: 0, completed: 0, incomplete: false, stopReason: null, records: [], summaries: [] };
  measurement: for (const tier of config.tiers) {
    const capture = captures.get(tier);
    for (let index = 0; index < config.runs; index++) {
      const started = performance.now();
      let fixture, driver;
      const record = { tier, mode: config.mode, index, completed: false, passed: false, journey: null, verdict: null, proof: null, failure: null, oracle: null, error: null, usage: null, healCount: 0, source: capture.metadata.source, scenarioHash: capture.metadata.scenarioHash, fixtureHash: runtime.fixtureInfo(tier, config.fixtureVersion).hash, requestedDelays: Object.fromEntries(["document", "api"].map((kind) => [kind, delayFor(config.latency, index, kind)])), elapsedMs: null };
      report.attempted++;
      try {
        fixture = await runtime.startFixture({ tier, version: config.fixtureVersion, runIndex: index, latency: config.latency });
        driver = runtime.createDriver();
        const output = await runtime.runScenario(structuredClone(capture.scenario), { driver, heal: false, llm: { id: "replay-no-llm", async complete() { throw new Error("LLM calls are forbidden in replay"); } }, replayEnvironment: { baseUrl: fixture.origin, allowedHosts: [new URL(capture.metadata.captureOrigin).host] } });
        report.completed++;
        record.completed = true;
        record.journey = !output.result.evidence.execution.blocked;
        record.verdict = output.result.verdict.passed;
        record.proof = output.result.verdict.proof ?? null;
        record.failure = output.result.verdict.failure ?? null;
        record.usage = output.result.usage ?? null;
        record.oracle = fixture.snapshot();
        record.passed = record.journey && record.verdict && record.oracle.complete && record.usage?.llmCalls === 0;
        if (record.usage?.llmCalls !== 0) record.error = { name: "ReplayUsageError", message: "Replay LLM usage must be measured zero" };
      } catch (error) {
        record.error = { name: error.name ?? "Error", message: String(error.message ?? error), stack: error.stack ?? null };
        record.oracle = fixture?.snapshot() ?? null;
      } finally {
        for (const resource of [driver, fixture]) {
          try { await resource?.close(); }
          catch (error) {
            const detail = { name: error.name ?? "Error", message: String(error.message ?? error), stack: error.stack ?? null };
            record.cleanupErrors = [...(record.cleanupErrors ?? []), detail];
            record.error ??= detail;
            record.passed = false;
            report.incomplete = true;
            report.stopReason = "Resource cleanup failed";
          }
        }
        record.elapsedMs = performance.now() - started;
      }
      report.records.push(record);
      if (report.incomplete) break measurement;
    }
  }
  report.summaries = config.tiers.map((tier) => {
    const records = report.records.filter((record) => record.tier === tier);
    const failures = records.filter((record) => !record.passed).length;
    return { tier, mode: config.mode, requested: config.runs, attempted: records.length, completed: records.filter((record) => record.completed).length, failures, failureRate: records.length ? failures / records.length : null };
  });
  report.finishedAt = new Date().toISOString();
  return report;
}
