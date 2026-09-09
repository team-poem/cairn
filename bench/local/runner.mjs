import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { validateConfig } from "./config.mjs";
import { loadCapture, saveCapture, sha256, validateScenario } from "./artifacts.mjs";
import { delayFor } from "./server.mjs";
import { createBudget } from "./budget.mjs";

export async function runBenchmark(config, runtime) {
  validateConfig(config);
  if (config.engineCommit !== runtime.engine.commit) throw new Error("Built engine commit does not match the requested commit");
  const captures = new Map();
  if (config.mode !== "discover") for (const tier of config.tiers) captures.set(tier, await loadCapture(join(config.captureDir, `${tier}.skill.json`), { tier, fixtureVersion: "v1", fixtureHash: runtime.fixtureInfo(tier, "v1").hash, mode: config.mode }));
  const { signal, ...configuration } = config;
  const budget = config.mode !== "replay" && config.llm.source === "llm" ? createBudget(config.llm) : null;
  const report = { schemaVersion: 1, engine: { ...runtime.engine }, configuration, configHash: sha256(JSON.stringify(configuration)), runtime: { node: process.version, platform: process.platform, arch: process.arch, ...runtime.info }, startedAt: new Date().toISOString(), finishedAt: null, requested: config.tiers.length * config.runs, attempted: 0, completed: 0, incomplete: false, stopReason: null, records: [], summaries: [] };
  measurement: for (const tier of config.tiers) {
    const capture = captures.get(tier);
    for (let index = 0; index < config.runs; index++) {
      if (signal?.aborted) { report.incomplete = true; report.stopReason = "Measurement aborted"; break measurement; }
      if (budget?.snapshot().stopReason) { report.incomplete = true; report.stopReason = budget.snapshot().stopReason; break measurement; }
      const started = performance.now();
      const previousCost = budget?.snapshot().measuredCostUsd;
      let fixture, driver;
      const observedUsage = { llmCalls: 0, measuredCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      const record = { tier, mode: config.mode, index, completed: false, passed: false, journey: null, verdict: null, proof: null, failure: null, oracle: null, error: null, usage: null, healCount: 0, source: capture?.metadata.source ?? { ...config.llm, kind: config.llm.source }, scenarioHash: capture?.metadata.scenarioHash ?? null, fixtureHash: runtime.fixtureInfo(tier, config.fixtureVersion).hash, requestedDelays: Object.fromEntries(["document", "api"].map((kind) => [kind, delayFor(config.latency, index, kind)])), elapsedMs: null };
      report.attempted++;
      record.captureFixtureHash = capture?.metadata.fixtureHash ?? null;
      record.captureSource = capture?.metadata.source ?? null;
      record.llmSource = config.mode === "replay" ? null : { ...config.llm, kind: config.llm.source };
      try {
        fixture = await runtime.startFixture({ tier, version: config.fixtureVersion, runIndex: index, latency: config.latency });
        driver = runtime.createDriver();
        const client = config.mode === "replay" ? { id: "replay-no-llm", async complete() { throw new Error("LLM calls are forbidden in replay"); } } : runtime.createLlm(config.llm, { tier, version: config.fixtureVersion, origin: fixture.origin, budget, signal });
        const llm = { id: client.id, complete(prompt, options = {}) {
          observedUsage.llmCalls++;
          let measured = false;
          return client.complete(prompt, { ...options, onUsage(usage) {
            if (!measured) {
              measured = true; observedUsage.measuredCalls++;
              for (const key of ["inputTokens", "outputTokens", "cacheReadTokens"]) observedUsage[key] += usage[key] ?? 0;
              options.onUsage?.(usage);
            }
          } });
        } };
        if (config.mode === "discover") {
          let scenario;
          try { scenario = await runtime.discover(runtime.fixtureInfo(tier, config.fixtureVersion).intent, { driver, llm, baseUrl: fixture.origin + runtime.fixtureInfo(tier, config.fixtureVersion).entryPath, semanticChecks: false, maxSteps: config.maxSteps ?? 20, signal }); }
          finally { record.usage = { ...observedUsage }; }
          report.completed++;
          record.completed = true;
          record.journey = !scenario.truncated;
          record.oracle = fixture.snapshot();
          validateScenario(scenario, "replay");
          if (!record.oracle.complete) throw new Error("Discovery did not complete the fixture");
          const path = join(config.outputDir, "captures", `run-${index + 1}`, `${tier}.skill.json`);
          await saveCapture(path, scenario, { tier, fixtureVersion: config.fixtureVersion, fixtureHash: record.fixtureHash, captureOrigin: fixture.origin, source: record.source, engine: runtime.engine }, runtime.saveSkillFile);
          record.artifactPath = path;
          record.scenarioHash = sha256(await readFile(path));
          record.passed = true;
        } else {
        const output = await runtime.runScenario(structuredClone(capture.scenario), { driver, heal: config.mode === "heal", llm, signal, maxSteps: config.maxSteps, replayEnvironment: { baseUrl: fixture.origin, allowedHosts: [new URL(capture.metadata.captureOrigin).host] } });
        report.completed++;
        record.completed = true;
        record.journey = !output.result.evidence.execution.blocked;
        record.verdict = output.result.verdict.passed;
        record.engineVerdict = structuredClone(output.result.verdict);
        record.proof = output.result.verdict.proof ?? null;
        record.failure = output.result.verdict.failure ?? null;
        record.usage = output.result.usage ?? null;
        record.healCount = (output.heals?.length ?? 0) + (output.stepHeals?.length ?? 0);
        record.oracle = fixture.snapshot();
        record.passed = record.journey && record.verdict && record.oracle.complete && (config.mode !== "replay" || record.usage?.llmCalls === 0);
        if (config.mode === "replay" && record.usage?.llmCalls !== 0) record.error = { name: "ReplayUsageError", message: "Replay LLM usage must be measured zero" };
        }
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
        record.requestLog = fixture?.requestLog?.() ?? [];
        record.observedUsage = { ...observedUsage };
        if (record.usage === null && observedUsage.llmCalls > 0) record.usage = { ...observedUsage };
        record.elapsedMs = performance.now() - started;
        if (budget) {
          const measured = budget.snapshot();
          record.costUsd = measured.costComplete ? measured.measuredCostUsd - previousCost : null;
          record.measuredCostUsd = measured.measuredCostUsd - previousCost;
          if (measured.stopReason) { report.incomplete = true; report.stopReason ??= measured.stopReason; }
        }
      }
      if (signal?.aborted) { report.incomplete = true; report.stopReason ??= "Measurement aborted"; }
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
  if (budget) report.budget = budget.snapshot();
  return report;
}
