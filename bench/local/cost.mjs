import { join } from "node:path";
import { access, readFile } from "node:fs/promises";
import { saveCapture, sha256, validateScenario } from "./artifacts.mjs";
import { delayFor } from "./server.mjs";
import { createBudget } from "./budget.mjs";
import { validateCostConfig } from "./config.mjs";

const BILLED = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"];

/**
 * Two arms over the same fixtures, the same churn schedule and one shared budget (#214).
 *
 * `agent` discovers on every run — what an LLM agent driving the browser each time costs.
 * `cairn` discovers once, replays after that, and heals when the app changes underneath it.
 *
 * The question is not whether a replay is free; `result.usage` already proves that per run. It is
 * whether discovering once and paying for the occasional repair costs less than discovering every
 * time, which depends entirely on how often the app breaks the freeze. So the arms share the
 * fixture version schedule: the app changes on the same run for both.
 *
 * Both arms of one tier run on a single reserved port, so the capture's frozen URLs match every
 * later run. That is what lets a heal come back re-freezable — under a replay environment the
 * engine deliberately withholds it (#171) — and it is why the cairn arm can carry a repair
 * forward instead of paying for the same break on every run after it.
 */
/**
 * A repair that leaves the fixture origin would drive an offline benchmark to a real host and fold
 * that traffic into the measured cost. The reliability runner is guarded by `loadCapture` and by a
 * replay environment's allowed hosts; this path has neither, so it checks the scenario itself.
 */
function assertOnOrigin(scenario, origin) {
  for (const step of scenario.steps) {
    if (step.kind !== "goto") continue;
    let parsed = null;
    try { parsed = new URL(step.url); } catch { parsed = null; }
    if (!parsed || parsed.origin !== origin) throw new Error("Scenario navigates away from the fixture origin");
  }
  return scenario;
}

export async function runCostComparison(config, runtime) {
  validateCostConfig({ ...config, signal: undefined });
  if (config.engineCommit !== runtime.engine.commit) throw new Error("Built engine commit does not match the requested commit");
  // Checked before the first browser opens. A capture that already exists would not be found until
  // the cairn arm's discovery, by which time the agent arm has been paid for in full.
  try { await access(join(config.outputDir, "captures")); throw new Error(`Output directory already holds captures: ${config.outputDir}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // A scripted run spends nothing, so it keeps no ledger; the call counter still observes it.
  const budget = createBudget(config.llm.source === "llm" ? config.llm : { maxCalls: Number.MAX_SAFE_INTEGER, maxCostUsd: Number.MAX_VALUE });
  const { signal, ...configuration } = config;
  const report = {
    schemaVersion: 1, kind: "cost-comparison",
    engine: { ...runtime.engine }, configuration, configHash: sha256(JSON.stringify(configuration)),
    runtime: { node: process.version, platform: process.platform, arch: process.arch, ...runtime.info },
    startedAt: new Date().toISOString(), finishedAt: null,
    requested: config.tiers.length * config.arms.length * config.runs, attempted: 0,
    incomplete: false, stopReason: null, records: [], summaries: [],
  };
  comparison: for (const tier of config.tiers) {
    const port = await runtime.reservePort();
    for (const arm of config.arms) {
      let frozen = null, frozenHash = null; // the cairn arm's current scenario, discovered once and replaced by a repair
      for (let index = 0; index < config.runs; index++) {
        if (signal?.aborted) { report.incomplete = true; report.stopReason = "Measurement aborted"; break comparison; }
        const stop = budget.snapshot().stopReason;
        if (stop) { report.incomplete = true; report.stopReason = stop; break comparison; }
        const version = config.fixtureVersions[index];
        const info = runtime.fixtureInfo(tier, version);
        const discovering = arm === "agent" || frozen === null;
        const started = performance.now();
        const before = budget.snapshot().measuredCostUsd;
        const recordsBefore = budget.snapshot().records.length;
        // `partialCalls` is what keeps a token total honest. The adapter reports whatever fields the
        // provider returned, and a call can report a cost with no usage at all, so summing blindly
        // would present an under-count as a complete total of every billed field.
        const observedUsage = { llmCalls: 0, measuredCalls: 0, partialCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
        const record = {
          tier, arm, index, fixtureVersion: version, action: discovering ? "discover" : "replay",
          completed: false, passed: false, verdict: null, oracle: null, error: null,
          healCount: 0, refrozen: false, usageComplete: false, models: null, scenarioHash: null, replayedScenarioHash: discovering ? null : frozenHash,
          fixtureHash: info.hash, requestedDelays: Object.fromEntries(["document", "api"].map((kind) => [kind, delayFor(config.latency, index, kind)])),
          usage: null, engineUsage: null, observedUsage: null, costUsd: null, measuredCostUsd: null, elapsedMs: null,
        };
        report.attempted++;
        let fixture, driver;
        try {
          fixture = await runtime.startFixture({ tier, version, runIndex: index, latency: config.latency, port });
          driver = runtime.createDriver();
          const client = runtime.createLlm(config.llm, { tier, version, origin: fixture.origin, budget, signal });
          const llm = { id: client.id, complete(prompt, options = {}) {
            observedUsage.llmCalls++;
            let measured = false;
            return client.complete(prompt, { ...options, onUsage(usage) {
              if (measured) return;
              measured = true; observedUsage.measuredCalls++;
              if (!BILLED.every((key) => Number.isFinite(usage[key]))) observedUsage.partialCalls++;
              for (const key of BILLED) observedUsage[key] += usage[key] ?? 0;
              options.onUsage?.(usage);
            } });
          } };
          if (discovering) {
            const scenario = await runtime.discover(info.intent, { driver, llm, baseUrl: fixture.origin + info.entryPath, semanticChecks: false, maxSteps: config.maxSteps ?? 20, signal });
            assertOnOrigin(validateScenario(scenario, "replay"), fixture.origin);
            record.completed = true;
            // Discovery has no frozen assertions to rule on, so a discover run's verdict says only
            // that a replayable scenario came back. The two arms' failure counts are not the same
            // measurement, and the report says so.
            record.verdict = true;
            if (arm === "cairn") {
              record.scenarioHash = frozenHash = await keep(config, runtime, `${tier}.skill.json`, scenario, { tier, version, info, fixture, record });
              frozen = scenario;
            }
          } else {
            // No replayEnvironment: the port is the capture's own, so the frozen URLs already match.
            const output = await runtime.runScenario(structuredClone(frozen), { driver, heal: true, llm, signal, maxSteps: config.maxSteps });
            record.completed = true;
            record.verdict = output.result.verdict.passed;
            record.engineUsage = output.result.usage ?? null;
            record.healCount = (output.heals?.length ?? 0) + (output.stepHeals?.length ?? 0);
            // The engine's own count and the benchmark's wrapper are separate vantage points, and a
            // free run is a claim about money. An engine call the wrapper never saw would mean the
            // run went through a client this comparison is not billing.
            if (!Number.isFinite(output.result.usage?.llmCalls)) throw new Error("Replay returned no usage, so its LLM calls cannot be checked");
            if (output.result.usage.llmCalls > observedUsage.llmCalls) throw new Error("Engine reported LLM calls the benchmark did not observe");
            if (output.healedScenario) {
              assertOnOrigin(validateScenario(output.healedScenario, "replay"), fixture.origin);
              // Saved under its own name: the scenario the arm replays from here on is the repair,
              // and a cost claim that rests on repairs has to leave them on disk.
              record.scenarioHash = frozenHash = await keep(config, runtime, `${tier}.repair-${index}.skill.json`, output.healedScenario, { tier, version, info, fixture, record });
              frozen = output.healedScenario; // the repair carries into every run after this one
              record.refrozen = true;
            }
          }
          record.oracle = fixture.snapshot();
          record.passed = Boolean(record.verdict) && record.oracle.complete;
        } catch (error) {
          record.error = { name: error.name ?? "Error", message: String(error.message ?? error), stack: error.stack ?? null };
          record.oracle = fixture?.snapshot() ?? null;
        } finally {
          for (const resource of [driver, fixture]) {
            try { await resource?.close(); }
            catch (error) {
              const detail = { name: error.name ?? "Error", message: String(error.message ?? error), stack: error.stack ?? null };
              record.cleanupErrors = [...(record.cleanupErrors ?? []), detail];
              record.error ??= detail; record.passed = false;
              report.incomplete = true; report.stopReason ??= "Resource cleanup failed";
            }
          }
          record.observedUsage = { ...observedUsage };
          record.usage = { ...observedUsage };
          record.usageComplete = observedUsage.measuredCalls === observedUsage.llmCalls && observedUsage.partialCalls === 0;
          const measured = budget.snapshot();
          record.models = splitByModel(measured.records.slice(recordsBefore));
          record.measuredCostUsd = measured.measuredCostUsd - before;
          record.costUsd = measured.costComplete ? record.measuredCostUsd : null;
          record.elapsedMs = performance.now() - started;
          if (measured.stopReason) { report.incomplete = true; report.stopReason ??= measured.stopReason; }
        }
        report.records.push(record);
        if (signal?.aborted) { report.incomplete = true; report.stopReason ??= "Measurement aborted"; }
        if (report.incomplete) break comparison;
        // The cairn arm cannot continue a tier whose first discovery never produced a scenario, and
        // the runs it never attempted are missing measurement, not a completed schedule.
        if (arm === "cairn" && frozen === null) {
          report.incomplete = true;
          report.stopReason ??= "The cairn arm had no scenario to replay after a failed discovery";
          break comparison; // as with every other stop, no later tier is paid for after this one
        }
      }
    }
  }
  report.summaries = summarize(report, config);
  report.finishedAt = new Date().toISOString();
  report.budget = budget.snapshot();
  return report;
}

/**
 * What each model billed over one run. The tool runs a helper model of its own beside the model
 * under test, so a per-model number is the only way to say what the model under test cost. The
 * arm totals stay the full amount: that is what the run actually spent.
 */
function splitByModel(records) {
  const models = {};
  for (const record of records) {
    for (const [id, usage] of Object.entries(record.models ?? {})) {
      const entry = (models[id] ??= { costUsd: 0, costComplete: true, listPriced: true, calls: 0, ...Object.fromEntries(BILLED.map((key) => [key, 0])) });
      entry.calls++;
      if (Number.isFinite(usage.costUsd)) entry.costUsd += usage.costUsd;
      else entry.costComplete = false;
      if (usage.costBasis !== "list") entry.listPriced = false;
      for (const key of BILLED) entry[key] += usage[key] ?? 0;
    }
  }
  return Object.keys(models).length ? models : null;
}

/** Every scenario a record names is written the same way and hashed over the same bytes, so two
 * records' hashes can be compared to tell whether the scenario actually changed. */
async function keep(config, runtime, name, scenario, { tier, version, info, fixture, record }) {
  const path = join(config.outputDir, "captures", name);
  await saveCapture(path, scenario, { tier, fixtureVersion: version, fixtureHash: info.hash, captureOrigin: fixture.origin, source: { ...config.llm, kind: config.llm.source }, engine: runtime.engine }, runtime.saveSkillFile);
  record.artifactPath = path;
  return sha256(await readFile(path));
}

/** Cumulative cost and tokens per arm per run index, the crossover, and how often cairn had to pay. */
function summarize(report, config) {
  const costMeasured = config.llm?.source === "llm";
  return config.tiers.map((tier) => {
    const arms = Object.fromEntries(config.arms.map((arm) => {
      const records = report.records.filter((record) => record.tier === tier && record.arm === arm);
      let cost = 0, tokens = 0;
      const cumulative = records.map((record) => {
        cost += record.measuredCostUsd ?? 0;
        tokens += BILLED.reduce((sum, key) => sum + (record.observedUsage?.[key] ?? 0), 0);
        return { index: record.index, costUsd: cost, tokens, calls: record.observedUsage?.llmCalls ?? 0 };
      });
      const models = {};
      for (const record of records) {
        for (const [id, usage] of Object.entries(record.models ?? {})) {
          const entry = (models[id] ??= { costUsd: 0, costComplete: true, listPriced: true, calls: 0, ...Object.fromEntries(BILLED.map((key) => [key, 0])) });
          entry.calls += usage.calls;
          if (usage.costComplete) entry.costUsd += usage.costUsd; else entry.costComplete = false;
          if (!usage.listPriced) entry.listPriced = false;
          for (const key of BILLED) entry[key] += usage[key] ?? 0;
        }
      }
      // Discovery, repair and replay are three different spends (#230), and the acceptance question
      // is what a repair costs on its own. A replay run that called the model is a repair attempt
      // whether or not it came back re-frozen: a heal that could not be verified still paid.
      const phase = (select) => {
        const subset = records.filter(select);
        return {
          runs: subset.length,
          passed: subset.filter((record) => record.passed).length,
          calls: subset.reduce((sum, record) => sum + (record.observedUsage?.llmCalls ?? 0), 0),
          tokens: subset.reduce((sum, record) => sum + BILLED.reduce((total, key) => total + (record.observedUsage?.[key] ?? 0), 0), 0),
          costUsd: subset.length && subset.every((record) => record.costUsd !== null) ? subset.reduce((sum, record) => sum + record.costUsd, 0) : null,
        };
      };
      const called = (record) => (record.observedUsage?.llmCalls ?? 0) > 0;
      const phases = {
        discovery: phase((record) => record.action === "discover"),
        repair: { ...phase((record) => record.action === "replay" && called(record)), refrozen: records.filter((record) => record.action === "replay" && record.refrozen).length },
        replay: phase((record) => record.action === "replay" && !called(record)),
      };
      return [arm, {
        attempted: records.length,
        models: Object.keys(models).length ? models : null,
        phases,
        failures: records.filter((record) => !record.passed).length,
        runsWithCalls: records.filter((record) => (record.observedUsage?.llmCalls ?? 0) > 0).length,
        runsWithoutCalls: records.filter((record) => record.passed && (record.observedUsage?.llmCalls ?? 0) === 0).length,
        repairs: records.filter((record) => record.refrozen).length,
        costComplete: records.length > 0 && records.every((record) => record.costUsd !== null),
        tokensComplete: records.length > 0 && records.every((record) => record.usageComplete),
        cumulative,
      }];
    }));
    // The first run index where discovering once has cost less than discovering every time, and
    // has stayed there. Null while cairn is still behind. Two arms that paid the same is a tie,
    // not a crossing, and cumulative sums are floating point, so the comparison needs a hair of
    // tolerance to keep a tie from reading as a lead.
    // From the second run only. On the first both arms do the same work on the same fixture, so a
    // difference there is provider pricing noise, not a freeze paying off.
    const [agent, cairn] = [arms.agent?.cumulative ?? [], arms.cairn?.cumulative ?? []];
    const shared = Math.min(agent.length, cairn.length);
    let crossover = null;
    for (let index = 1; index < shared; index++) {
      if (agent[index].costUsd - cairn[index].costUsd > 1e-9) { crossover ??= index; }
      else crossover = null;
    }
    // Four ways the number would be a claim rather than a measurement, and each is a state this
    // runner can reach. A scripted source makes no paid call, so its zeros are an absence of
    // measurement. An arm that stopped short of the schedule was never compared over it. A run
    // whose cost the provider never reported adds nothing to that arm's total, which would score
    // an unknown as free. And a failed run costs nothing, so a broken arm looks like a cheap one:
    // the reserved port makes that concrete, since a port taken between reserving and listening
    // fails every remaining run of the tier at zero cost. In all four the crossover is withheld.
    const usable = (arm) => Boolean(arm) && arm.cumulative.length === config.runs && arm.costComplete && arm.failures === 0;
    const comparable = costMeasured && usable(arms.agent) && usable(arms.cairn);
    const why = !costMeasured ? "this source makes no paid call"
      : !arms.agent || !arms.cairn ? "a comparison needs both arms"
      : [arms.agent, arms.cairn].some((arm) => arm.cumulative.length !== config.runs) ? "an arm stopped short of the schedule"
      : [arms.agent, arms.cairn].some((arm) => arm.failures > 0) ? "a run failed, and a failed run costs nothing"
      : "a run's cost was never reported";
    return { tier, arms, crossover: comparable ? crossover : null, costMeasured, comparable, comparableNote: comparable ? null : why, runs: config.runs };
  });
}
