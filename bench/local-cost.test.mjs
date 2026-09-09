// file: bench/local-cost.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const commit = "a".repeat(40);
const zeroUsage = { llmCalls: 0, measuredCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
const green = () => ({ result: { verdict: { passed: true }, usage: { ...zeroUsage } }, heals: [], stepHeals: [] });
const scenarioFor = (origin, version) => ({
  name: `navigation-${version}`,
  steps: [{ kind: "goto", url: `${origin}/` }, { kind: "click", target: { role: "link", text: version === "v2" ? "Proceed" : "Continue" } }],
  assertions: [{ kind: "navigated", to: `${origin}/done` }],
});

async function harness(t, patch = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cairn local cost "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const events = [];
  const here = { version: "v1", origin: "" };
  let ports = 0, drivers = 0, calls = 0;
  const h = {
    dir, events, here,
    // Cost per call, so a test can make a repair cheap or ruinous without touching the runner.
    priceOf: (prompt) => (prompt.startsWith("discover") ? 0.1 : 0.02),
    runtime: {
      engine: { version: "2.9.0", commit, dirty: false, buildHash: "c".repeat(64) },
      info: {},
      fixtureInfo: (tier, version) => ({ hash: `${tier}-${version}`, entryPath: "/", intent: "Reach the destination" }),
      async reservePort() { const port = 20000 + ++ports; events.push(`port:${port}`); return port; },
      async startFixture({ tier, version, port }) {
        here.version = version;
        here.origin = `http://127.0.0.1:${port}`;
        events.push(`server:${tier}:${version}:${port}`);
        return { origin: here.origin, snapshot: () => ({ complete: true }), async close() {} };
      },
      createDriver() { const id = ++drivers; return { id, async close() {} }; },
      createLlm(_config, context) {
        return { id: "fake", async complete(prompt, options = {}) {
          context.budget.reserve();
          calls++;
          options.onUsage?.({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 10 });
          context.budget.record({ costUsd: h.priceOf(prompt, calls) });
          return { text: "{}" };
        } };
      },
      async discover(_intent, options) {
        events.push(`discover:${here.version}`);
        await options.llm.complete("discover the journey");
        return scenarioFor(here.origin, here.version);
      },
      async runScenario(scenario, options) {
        events.push(`replay:${here.version}:${scenario.name}`);
        if (scenario.name.endsWith(here.version)) return green();
        await options.llm.complete("heal the broken step");
        return { ...green(), heals: [{ kind: "step" }], healedScenario: scenarioFor(here.origin, here.version) };
      },
      async saveSkillFile(file, value) { await mkdir(dirname(file), { recursive: true }); await import("node:fs/promises").then((fs) => fs.writeFile(file, JSON.stringify(value, null, 2))); },
    },
    config: {
      mode: "cost", tiers: ["navigation"], arms: ["agent", "cairn"], runs: 4,
      fixtureVersions: ["v1", "v1", "v2", "v2"], latency: { document: [0], api: [0, 30] },
      engineCommit: commit, outputDir: join(dir, "results"), maxSteps: 12,
      llm: { source: "llm", backend: "claude-code", model: "test-model", maxCalls: 50, maxCostUsd: 100 },
      ...patch,
    },
  };
  return h;
}

const load = () => import("./local/cost.mjs");

test("costArmsMeetTheSameChurnOnOneOrigin: both arms share a reserved port and the same version per run index", async (t) => {
  const { runCostComparison } = await load();
  const h = await harness(t);
  const report = await runCostComparison(h.config, h.runtime);
  assert.equal(report.requested, 8);
  assert.equal(report.attempted, 8);
  assert.equal(report.incomplete, false);
  assert.equal(h.events.filter((event) => event.startsWith("port:")).length, 1);
  const ports = new Set(h.events.filter((event) => event.startsWith("server:")).map((event) => event.split(":").at(-1)));
  assert.equal(ports.size, 1);
  const versionsOf = (arm) => report.records.filter((record) => record.arm === arm).map((record) => record.fixtureVersion);
  assert.deepEqual(versionsOf("agent"), h.config.fixtureVersions);
  assert.deepEqual(versionsOf("cairn"), h.config.fixtureVersions);
  assert.deepEqual(report.records.filter((record) => record.arm === "agent").map((record) => record.action), ["discover", "discover", "discover", "discover"]);
  assert.deepEqual(report.records.filter((record) => record.arm === "cairn").map((record) => record.action), ["discover", "replay", "replay", "replay"]);
  assert.ok(report.records.every((record) => record.passed));
});

test("costReplayEnvironmentIsNeverUsed: a frozen run is asked to heal and its repair is not withheld", async (t) => {
  const { runCostComparison } = await load();
  const h = await harness(t);
  const seen = [];
  const run = h.runtime.runScenario;
  h.runtime.runScenario = async (scenario, options) => { seen.push(options); return run(scenario, options); };
  await runCostComparison(h.config, h.runtime);
  assert.ok(seen.length > 0);
  assert.ok(seen.every((options) => options.replayEnvironment === undefined));
  assert.ok(seen.every((options) => options.heal === true));
});

test("costCairnCarriesARepairForward: the run after a heal replays the repaired scenario for free", async (t) => {
  const { runCostComparison } = await load();
  const h = await harness(t);
  const report = await runCostComparison(h.config, h.runtime);
  const cairn = report.records.filter((record) => record.arm === "cairn");
  assert.deepEqual(cairn.map((record) => record.refrozen), [false, false, true, false]);
  assert.deepEqual(cairn.map((record) => record.observedUsage.llmCalls), [1, 0, 1, 0]);
  assert.equal(cairn[2].healCount, 1);
  assert.deepEqual(h.events.filter((event) => event.startsWith("replay:")), ["replay:v1:navigation-v1", "replay:v2:navigation-v1", "replay:v2:navigation-v2"]);
  const summary = report.summaries[0];
  assert.equal(summary.arms.cairn.repairs, 1);
  assert.equal(summary.arms.cairn.runsWithCalls, 2);
  assert.equal(summary.arms.cairn.runsWithoutCalls, 2);
  assert.equal(summary.arms.agent.runsWithCalls, 4);
  assert.equal(summary.arms.agent.runsWithoutCalls, 0);
  assert.equal(summary.arms.agent.repairs, 0);
});

test("costCumulativeTotalsAreSumsOfTheirRecords: money and every billed token field accumulate per arm", async (t) => {
  const { runCostComparison } = await load();
  const h = await harness(t);
  const report = await runCostComparison(h.config, h.runtime);
  const arms = report.summaries[0].arms;
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} vs ${expected}`);
  arms.agent.cumulative.forEach((point, index) => close(point.costUsd, 0.1 * (index + 1)));
  assert.deepEqual(arms.cairn.cumulative.map((point) => point.calls), [1, 0, 1, 0]);
  [0.1, 0.1, 0.12, 0.12].forEach((expected, index) => close(arms.cairn.cumulative[index].costUsd, expected));
  assert.deepEqual(arms.agent.cumulative.map((point) => point.tokens), [135, 270, 405, 540]);
  assert.deepEqual(arms.cairn.cumulative.map((point) => point.tokens), [135, 135, 270, 270]);
  for (const arm of Object.values(arms)) assert.equal(arm.costComplete, true);
  close(report.budget.measuredCostUsd, 0.52);
  assert.equal(report.budget.calls, 6);
  const summed = report.records.reduce((total, record) => total + record.measuredCostUsd, 0);
  close(summed, report.budget.measuredCostUsd);
});

test("costCrossoverNeedsCairnToStayCheaper: a later expensive repair clears an earlier crossing", async (t) => {
  const { runCostComparison } = await load();
  const h = await harness(t, { fixtureVersions: ["v1", "v1", "v2", "v1"] });
  h.priceOf = (prompt, call) => (prompt.startsWith("discover") ? 0.1 : call > 6 ? 0.3 : 0.03);
  const report = await runCostComparison(h.config, h.runtime);
  const { arms, crossover } = report.summaries[0];
  assert.deepEqual(arms.cairn.cumulative.map((point) => Number(point.costUsd.toFixed(4))), [0.1, 0.1, 0.13, 0.43]);
  assert.deepEqual(arms.agent.cumulative.map((point) => Number(point.costUsd.toFixed(4))), [0.1, 0.2, 0.3, 0.4]);
  assert.equal(crossover, null);
});

test("costCrossoverIsTheFirstRunThatStaysCheaper: a stable lead reports its own index", async (t) => {
  const { runCostComparison } = await load();
  const h = await harness(t);
  const report = await runCostComparison(h.config, h.runtime);
  assert.equal(report.summaries[0].crossover, 1);
  assert.equal(report.summaries[0].runs, 4);
});

test("costSharedBudgetStopsBothArms: the threshold ends the comparison and the report says so", async (t) => {
  const { runCostComparison } = await load();
  const h = await harness(t, { llm: { source: "llm", backend: "claude-code", model: "test-model", maxCalls: 50, maxCostUsd: 0.25 } });
  const report = await runCostComparison(h.config, h.runtime);
  assert.equal(report.incomplete, true);
  assert.match(report.stopReason, /threshold/i);
  assert.ok(report.attempted < report.requested);
  assert.equal(report.records.filter((record) => record.arm === "cairn").length, 0);
});

test("costRefusesAStaleBuild: a report can only describe the commit that was built", async (t) => {
  const { runCostComparison } = await load();
  const h = await harness(t, { engineCommit: "b".repeat(40) });
  await assert.rejects(runCostComparison(h.config, h.runtime), /commit/i);
});

test("costStopsATierWhoseFirstDiscoveryFailed: cairn cannot replay what it never froze", async (t) => {
  const { runCostComparison } = await load();
  const h = await harness(t);
  h.runtime.discover = async (_intent, options) => { await options.llm.complete("discover the journey"); throw new Error("discovery gave up"); };
  const report = await runCostComparison(h.config, h.runtime);
  const cairn = report.records.filter((record) => record.arm === "cairn");
  assert.equal(cairn.length, 1);
  assert.match(cairn[0].error.message, /discovery gave up/);
  assert.equal(cairn[0].passed, false);
  assert.equal(report.records.filter((record) => record.arm === "agent").length, 4);
  assert.equal(report.summaries[0].arms.cairn.attempted, 1);
});

test("costReportRegeneratesItsTable: the JSON is authoritative and the markdown states what a crossover is not", async (t) => {
  const { runCostComparison } = await load();
  const { writeReport, renderCostMarkdown } = await import("./local/report.mjs");
  const h = await harness(t);
  const report = await runCostComparison(h.config, h.runtime);
  const paths = await writeReport(report, h.config.outputDir, renderCostMarkdown);
  const saved = JSON.parse(await readFile(paths.json, "utf8"));
  assert.deepEqual(saved, report);
  const markdown = await readFile(paths.markdown, "utf8");
  assert.equal(markdown, renderCostMarkdown(saved));
  assert.match(markdown, /Crossover: run 2/);
  assert.match(markdown, /not a general saving/i);
  assert.match(markdown, /claude-code: test-model/);
  assert.match(markdown, /cache creation/i);
  assert.doesNotMatch(markdown, /cheaper than|saves you|\d+x/i);
});

test("costConfigurationRefusesASchedulItCannotCompare: runs versions arms and a spending threshold", async (t) => {
  const { validateCostConfig } = await import("./local/config.mjs");
  const h = await harness(t);
  const base = { ...h.config };
  assert.deepEqual(validateCostConfig({ ...base }), base);
  const rejects = (patch, pattern) => assert.throws(() => validateCostConfig({ ...base, ...patch }), pattern);
  rejects({ runs: 1 }, /at least 2/);
  rejects({ fixtureVersions: ["v1", "v1", "v2"] }, /every run/);
  rejects({ fixtureVersions: ["v2", "v1", "v2", "v2"] }, /first run must be v1/);
  rejects({ fixtureVersions: ["v1", "v1", "v3", "v2"] }, /every run/);
  rejects({ arms: ["agent", "agent"] }, /arms/);
  rejects({ arms: ["cairn", "browser"] }, /arms/);
  rejects({ tiers: [] }, /tiers/);
  rejects({ engineCommit: "abc" }, /commit/);
  rejects({ llm: { ...base.llm, maxCostUsd: 0 } }, /threshold/);
  rejects({ llm: { ...base.llm, model: "" } }, /backend and model/);
  rejects({ mode: "replay" }, /mode/);
});

test("costScriptedSourceReportsNoMoney: zeros from an unpaid source are not a free comparison", async (t) => {
  const { runCostComparison } = await load();
  const { renderCostMarkdown } = await import("./local/report.mjs");
  const h = await harness(t, { llm: { source: "scripted", label: "offline cost smoke" } });
  h.priceOf = () => 0;
  const report = await runCostComparison(h.config, h.runtime);
  const summary = report.summaries[0];
  assert.equal(summary.costMeasured, false);
  assert.equal(summary.crossover, null);
  assert.equal(summary.arms.cairn.runsWithoutCalls, 2);
  const markdown = renderCostMarkdown(report);
  assert.match(markdown, /Crossover: not measured/);
  assert.match(markdown, /not measured \|/);
  assert.doesNotMatch(markdown, /\$0\.000000/);
});

test("costWithholdsACrossoverItCannotStandBehind: unknown cost failed runs and a short arm all void it", async (t) => {
  const { runCostComparison } = await load();
  const { renderCostMarkdown } = await import("./local/report.mjs");
  const notes = [];
  const cases = {
    // A cost the provider never reported adds nothing to the arm's total, so it would otherwise
    // score as a free run for whichever arm made the call.
    unknownCost: (h) => { h.runtime.createLlm = (_config, context) => ({ id: "fake", async complete(_prompt, options = {}) { context.budget.reserve(); options.onUsage?.({ inputTokens: 1 }); context.budget.record({ costUsd: null }); return { text: "{}" }; } }); },
    // A failed run costs nothing, so a broken arm reads as a cheap one.
    failedRun: (h) => { const run = h.runtime.runScenario; h.runtime.runScenario = async (scenario, options) => ({ ...(await run(scenario, options)), result: { verdict: { passed: false }, usage: { ...zeroUsage } } }); },
    oneArm: (h) => { h.config.arms = ["agent"]; },
  };
  for (const [name, patch] of Object.entries(cases)) {
    const h = await harness(t);
    patch(h);
    const report = await runCostComparison(h.config, h.runtime);
    const summary = report.summaries[0];
    assert.equal(summary.comparable, false, name);
    assert.equal(summary.crossover, null, name);
    assert.match(renderCostMarkdown(report), /Crossover: not measured; /, name);
    assert.ok(summary.comparableNote, name);
    notes.push(summary.comparableNote);
  }
  // Each condition says which one it was, so a reader is not left guessing why the number is absent.
  assert.equal(new Set(notes).size, notes.length);
});

test("costMarksAnAbandonedTierIncomplete: runs that were never attempted are not a finished schedule", async (t) => {
  const { runCostComparison } = await load();
  const { renderCostMarkdown } = await import("./local/report.mjs");
  const h = await harness(t);
  h.runtime.discover = async (_intent, options) => { await options.llm.complete("discover the journey"); throw new Error("discovery gave up"); };
  const report = await runCostComparison(h.config, h.runtime);
  assert.equal(report.incomplete, true);
  assert.match(report.stopReason, /no scenario to replay/i);
  assert.ok(report.attempted < report.requested);
  assert.match(renderCostMarkdown(report), /INCOMPLETE/);
});

test("costRejectsARepairThatLeavesTheFixture: an offline benchmark never follows a heal to a real host", async (t) => {
  const { runCostComparison } = await load();
  const h = await harness(t);
  const seen = [];
  const run = h.runtime.runScenario;
  h.runtime.runScenario = async (scenario, options) => {
    seen.push(scenario.steps[0].url);
    if (scenario.name.endsWith(h.here.version)) return run(scenario, options);
    await options.llm.complete("heal the broken step");
    const escaped = { ...scenarioFor(h.here.origin, h.here.version), steps: [{ kind: "goto", url: "https://example.com/" }] };
    return { ...green(), heals: [{ kind: "step" }], healedScenario: escaped };
  };
  const report = await runCostComparison(h.config, h.runtime);
  const cairn = report.records.filter((record) => record.arm === "cairn");
  assert.match(cairn[2].error.message, /away from the fixture origin/);
  assert.equal(cairn[2].refrozen, false);
  assert.equal(cairn[2].passed, false);
  assert.ok(seen.every((url) => url.startsWith("http://127.0.0.1:")));
});

test("costFailsARunTheEngineBilledElsewhere: engine-reported calls the benchmark never saw are not free", async (t) => {
  const { runCostComparison } = await load();
  const h = await harness(t, { fixtureVersions: ["v1", "v1"], runs: 2 });
  h.runtime.runScenario = async () => ({ ...green(), result: { verdict: { passed: true }, usage: { ...zeroUsage, llmCalls: 2 } } });
  const report = await runCostComparison(h.config, h.runtime);
  const replay = report.records.find((record) => record.action === "replay");
  assert.match(replay.error.message, /did not observe/i);
  assert.equal(replay.passed, false);
});

test("costFailsAReplayWithoutUsage: a run that reports no usage cannot be recorded as free", async (t) => {
  const { runCostComparison } = await load();
  const h = await harness(t, { fixtureVersions: ["v1", "v1"], runs: 2 });
  h.runtime.runScenario = async () => { const out = green(); delete out.result.usage; return out; };
  const report = await runCostComparison(h.config, h.runtime);
  const replay = report.records.find((record) => record.action === "replay");
  assert.match(replay.error.message, /no usage/i);
  assert.equal(replay.passed, false);
});

test("costWritesEveryScenarioItReplays: a repair is on disk and hashed the same way as the freeze", async (t) => {
  const { runCostComparison } = await load();
  const h = await harness(t);
  const report = await runCostComparison(h.config, h.runtime);
  const cairn = report.records.filter((record) => record.arm === "cairn");
  const paths = cairn.filter((record) => record.artifactPath).map((record) => record.artifactPath);
  assert.equal(paths.length, 2);
  for (const path of paths) {
    const saved = JSON.parse(await readFile(path, "utf8"));
    const meta = JSON.parse(await readFile(path + ".meta.json", "utf8"));
    assert.equal(meta.scenarioHash, sha256(await readFile(path)));
    assert.equal(saved.name.startsWith("navigation-"), true);
  }
  assert.deepEqual(cairn.map((record) => record.scenarioHash), [
    sha256(await readFile(paths[0])), null, sha256(await readFile(paths[1])), null,
  ]);
  assert.notEqual(cairn[0].scenarioHash, cairn[2].scenarioHash);
});

test("costKeepsTiersApart: each tier reserves its own port and summarizes only its own records", async (t) => {
  const { runCostComparison } = await load();
  const h = await harness(t, { tiers: ["navigation", "form"] });
  const report = await runCostComparison(h.config, h.runtime);
  assert.equal(h.events.filter((event) => event.startsWith("port:")).length, 2);
  assert.equal(report.summaries.length, 2);
  assert.deepEqual(report.summaries.map((summary) => summary.tier), ["navigation", "form"]);
  for (const summary of report.summaries) {
    assert.equal(summary.arms.agent.attempted, 4);
    assert.equal(summary.arms.cairn.attempted, 4);
    assert.equal(summary.arms.cairn.repairs, 1);
  }
  const ports = new Set(h.events.filter((event) => event.startsWith("server:")).map((event) => event.split(":").slice(1).join(":")));
  assert.equal(new Set([...ports].map((entry) => entry.split(":")[0])).size, 2);
});

test("costValidatesItsOwnConfiguration: a programmatic caller is refused before any browser opens", async (t) => {
  const { runCostComparison } = await load();
  const h = await harness(t, { fixtureVersions: ["v1", "v1"] });
  await assert.rejects(runCostComparison(h.config, h.runtime), /fixtureVersions/);
  assert.deepEqual(h.events, []);
});

test("costStopsPayingOnceTheReportIsIncomplete: a later tier is never charged after an abandoned one", async (t) => {
  const { runCostComparison } = await load();
  const h = await harness(t, { tiers: ["navigation", "form"] });
  h.runtime.discover = async (_intent, options) => { await options.llm.complete("discover the journey"); throw new Error("discovery gave up"); };
  const report = await runCostComparison(h.config, h.runtime);
  assert.equal(report.incomplete, true);
  assert.ok(report.records.every((record) => record.tier === "navigation"));
  assert.equal(h.events.filter((event) => event.startsWith("port:")).length, 1);
});

test("costRefusesAUsedOutputDirectoryBeforeSpending: a rerun is rejected before the first browser opens", async (t) => {
  const { runCostComparison } = await load();
  const h = await harness(t);
  await runCostComparison(h.config, h.runtime);
  const events = h.events.length;
  await assert.rejects(runCostComparison(h.config, h.runtime), /already holds captures/);
  assert.equal(h.events.length, events);
});

test("costNamesTheScenarioEveryRunReplayed: a free run says which frozen bytes it ran", async (t) => {
  const { runCostComparison } = await load();
  const h = await harness(t);
  const report = await runCostComparison(h.config, h.runtime);
  const cairn = report.records.filter((record) => record.arm === "cairn");
  assert.equal(cairn[0].replayedScenarioHash, null);
  assert.equal(cairn[1].replayedScenarioHash, cairn[0].scenarioHash);
  assert.equal(cairn[2].replayedScenarioHash, cairn[0].scenarioHash);
  assert.equal(cairn[3].replayedScenarioHash, cairn[2].scenarioHash);
  assert.ok(report.records.filter((record) => record.arm === "agent").every((record) => record.replayedScenarioHash === null));
});

test("costMarksATokenTotalItCouldNotComplete: a call that reported no usage makes the total a lower bound", async (t) => {
  const { runCostComparison } = await load();
  const { renderCostMarkdown } = await import("./local/report.mjs");
  const h = await harness(t, { fixtureVersions: ["v1", "v1"], runs: 2 });
  let call = 0;
  h.runtime.createLlm = (_config, context) => ({ id: "fake", async complete(_prompt, options = {}) {
    context.budget.reserve();
    call++;
    // A provider can report a cost with no usage at all, and can report only some of the fields.
    if (call === 2) options.onUsage?.({ outputTokens: 20 });
    if (call > 2) options.onUsage?.({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 10 });
    context.budget.record({ costUsd: 0.1 });
    return { text: "{}" };
  } });
  const report = await runCostComparison(h.config, h.runtime);
  const agent = report.records.filter((record) => record.arm === "agent");
  assert.deepEqual(agent.map((record) => record.usageComplete), [false, false]);
  assert.equal(agent[0].observedUsage.measuredCalls, 0);
  assert.equal(agent[1].observedUsage.partialCalls, 1);
  const arms = report.summaries[0].arms;
  assert.equal(arms.agent.tokensComplete, false);
  assert.equal(arms.cairn.tokensComplete, true);
  assert.deepEqual(arms.agent.cumulative.map((point) => point.tokens), [0, 20]);
  const markdown = renderCostMarkdown(report);
  assert.match(markdown, /at least 20/);
  assert.match(markdown, /lower bound/);
  // Money is a separate question: every call reported a cost, so the cost column stays measured.
  assert.equal(arms.agent.costComplete, true);
});
