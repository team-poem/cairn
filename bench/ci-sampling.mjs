// Keep scheduling and result validation independent of subprocess execution.
export const measuredRounds = 3;

export async function collectReplays({ reports, attempt, baseRoot, headRoot, captures, environment, workload, fixtureInfo }) {
  // Warmups are retained as artifacts but excluded from latency statistics.
  let failed = false, warmupFailed = false;
  for (const [side, root] of [["base", baseRoot], ["head", headRoot]]) {
    const warmup = await attempt(root, `${side}-warmup`, "replay", captures);
    if (warmup.failed || warmup.report.records.some(row => !row.passed)) { failed = true; warmupFailed = true; }
  }
  for (let round = 0; round < workload.runs; round++) {
    for (const side of round % 2 ? ["head", "base"] : ["base", "head"]) {
      const { report, failed: runFailed } = await attempt(side === "base" ? baseRoot : headRoot, `${side}-${round + 1}`, "replay", captures);
      if (runFailed) failed = true;
      reports[side].incomplete ||= report.incomplete || (runFailed && report.records.every(row => row.passed));
      if (report.engine.commit !== reports[side].commit || report.engine.buildHash !== reports[side].buildHash) throw new Error("Engine changed during measurement");
      for (const key of ["node", "chrome", "mcp", "platform", "arch"]) {
        if (report.runtime[key] !== environment[key]) throw new Error(`Runtime ${key} changed during measurement`);
      }
      for (const row of report.records) {
        if (row.scenarioHash !== workload.captures.find(capture => capture.tier === row.tier)?.scenarioHash) throw new Error("Capture changed during measurement");
        if (row.fixtureHash !== fixtureInfo(row.tier, "v1").hash) throw new Error("Fixture changed during measurement");
        reports[side].records.push({ tier: row.tier, round, elapsedMs: row.elapsedMs, passed: row.passed, llmCalls: row.engineUsage?.llmCalls ?? null, observedLlmCalls: row.observedUsage?.llmCalls ?? null });
      }
    }
  }
  return { failed, warmupFailed };
}
