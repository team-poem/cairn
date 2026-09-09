import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const cell = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");

export function renderMarkdown(report) {
  const rows = report.summaries.map((summary) => {
    const records = report.records.filter((record) => record.tier === summary.tier && record.mode === summary.mode);
    const calls = (field) => {
      if (field === "engineUsage" && summary.mode === "discover") return "n/a";
      const counts = records.map((record) => (field === "engineUsage" ? ("engineUsage" in record ? record.engineUsage : record.engineVerdict ? record.usage : null) : record[field])?.llmCalls);
      return counts.every(Number.isFinite) ? counts.reduce((sum, count) => sum + count, 0) : "unknown";
    };
    const elapsed = records.length ? (records.reduce((n, record) => n + record.elapsedMs, 0) / records.length).toFixed(0) : "n/a";
    return `| ${cell(summary.tier)} | ${cell(summary.mode)} | ${summary.requested} | ${summary.attempted} | ${summary.completed} | ${summary.failures} | ${summary.failureRate === null ? "n/a" : (summary.failureRate * 100).toFixed(1) + "%"} | ${calls("engineUsage")} | ${calls("observedUsage")} | ${elapsed} |`;
  });
  const captureRows = new Set();
  const identities = [...report.records];
  for (const tier of report.configuration.tiers ?? []) if (!identities.some((record) => record.tier === tier)) identities.push({ tier });
  for (const record of identities) {
    const source = record.captureSource;
    const sourceLabel = !record.scenarioHash ? "missing" : source?.kind === "scripted" ? `scripted: ${source.label ?? "unknown"}` : source?.kind === "llm" ? `${source.backend ?? "unknown"}: ${source.model ?? "unknown"}` : "unknown";
    const values = [record.tier, record.fixtureHash ?? "unknown", record.captureFixtureVersion ?? "unknown", record.captureFixtureHash ?? "unknown", record.scenarioHash ?? "missing", sourceLabel];
    captureRows.add(`| ${values.map(cell).join(" | ")} |`);
  }
  const captures = `Executed fixture version: ${cell(report.configuration.fixtureVersion ?? "unknown")}\n\n| Tier | Executed fixture SHA-256 | Capture fixture version | Capture fixture SHA-256 | Scenario SHA-256 | Discovery source |\n| --- | --- | --- | --- | --- | --- |\n${[...captureRows].join("\n")}`;
  const sources = [...new Set(report.records.map((record) => record.source?.kind ?? "unknown"))].join(", ");
  return `# Local benchmark\n\n${report.incomplete ? "INCOMPLETE: " + cell(report.stopReason) : "Requested attempts completed."}\n\nEngine: ${cell(report.engine.version)} at ${cell(report.engine.commit)} (dirty: ${report.engine.dirty}).\nBuild SHA-256: ${cell(report.engine.buildHash)}.\nConfiguration SHA-256: ${report.configHash}.\nMeasured: ${report.startedAt} → ${report.finishedAt}.\nCapture/discovery sources: ${cell(sources)}. Execution LLM source: ${cell(report.configuration.mode === "replay" ? "none (replay)" : report.configuration.llm?.source ?? "unknown")}.\n\n| Tier | Mode | Requested | Attempted | Engine returned | Failures | Failure rate | Engine LLM calls | Observed LLM calls | Average ms |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows.join("\n")}\n\n${captures}\n\nFailures use all attempted runs as their denominator, including exceptions. Engine-reported and bench-observed LLM calls are separate columns; replay requires both to be measured zero. Discovery usage is counted by the bench because discovery returns a Scenario without an engine usage report. Elapsed time includes resource startup and awaited cleanup. Requested delays and observed times are distinct fields in JSON.\n\nEngine journey, verdict, proof and fixture completion are separate observations in JSON. A green engine verdict cannot override an incomplete fixture. Zero LLM calls on a successful v2 run indicate unaided survival; repair counts alone do not describe outcome rediscovery.\n\nRepeated replay measures these captures under this configuration, not discovery success or general application coverage. Scripted discovery is smoke verification and must not be pooled with actual LLM discovery.\n${report.budget ? `\nReported provider cost: $${report.budget.measuredCostUsd.toFixed(6)}; cost complete: ${report.budget.costComplete}. This is reported cost, not a strict billing cap; a threshold can be exceeded by the final call. Reaching a call or cost limit marks the report incomplete even if the final requested engine attempt returned successfully; completed counts and per-attempt outcomes remain unchanged.\n` : ""}`;
}

/**
 * The comparison (#214): cumulative cost per arm against the run index, and the run at which
 * discovering once has cost less than discovering every time. Everything printed is a sum over
 * `records`, so a reader can recompute any cell from the JSON.
 */
export function renderCostMarkdown(report) {
  const money = (value) => `$${value.toFixed(6)}`;
  const sections = report.summaries.map((summary) => {
    const arms = Object.entries(summary.arms);
    const crossover = !summary.comparable ? `not measured; ${cell(summary.comparableNote)}`
      : summary.crossover === null ? "not reached in this schedule"
      : `run ${summary.crossover + 1}`;
    const header = `| Run | Fixture | ${arms.map(([arm]) => `${arm} calls this run | ${arm} tokens to date | ${arm} cost to date`).join(" | ")} |`;
    const divider = `| ---: | --- | ${arms.map(() => "---: | ---: | ---:").join(" | ")} |`;
    const rows = Array.from({ length: summary.runs }, (_, index) => {
      const cells = arms.map(([, arm]) => {
        const point = arm.cumulative[index];
        if (!point) return "n/a | n/a | n/a";
        const cost = !summary.costMeasured ? "not measured" : arm.costComplete ? money(point.costUsd) : "unknown";
        return `${point.calls} | ${arm.tokensComplete ? point.tokens : `at least ${point.tokens}`} | ${cost}`;
      });
      return `| ${index + 1} | ${cell(report.configuration.fixtureVersions[index])} | ${cells.join(" | ")} |`;
    });
    const notes = arms.map(([name, arm]) => `${name}: ${arm.runsWithCalls} of ${arm.attempted} run(s) called the model, ${arm.runsWithoutCalls} made no call, ${arm.failures} failed, ${arm.repairs} repair(s) carried forward`);
    return `### ${cell(summary.tier)}\n\nCrossover: ${crossover}.\n${notes.map((note) => `- ${cell(note)}`).join("\n")}\n\n${header}\n${divider}\n${rows.join("\n")}`;
  });
  return `# Local cost comparison\n\n${report.incomplete ? "INCOMPLETE: " + cell(report.stopReason) : "Requested attempts completed."}\n\nEngine: ${cell(report.engine.version)} at ${cell(report.engine.commit)} (dirty: ${report.engine.dirty}).\nBuild SHA-256: ${cell(report.engine.buildHash)}.\nConfiguration SHA-256: ${report.configHash}.\nMeasured: ${report.startedAt} → ${report.finishedAt}.\nLLM source: ${cell(report.configuration.llm?.source ?? "unknown")}${report.configuration.llm?.source === "llm" ? ` (${cell(report.configuration.llm.backend)}: ${cell(report.configuration.llm.model)})` : ""}.\n\n${sections.join("\n\n")}\n\nThe agent arm discovers on every run; the cairn arm discovers once and then replays, healing when the fixture version changes under it and carrying the repair forward. Both arms meet the same version on the same run. A discover run fails when no replayable scenario came back or the fixture never completed; a replay run additionally has to satisfy the frozen assertions, so the two failure counts are not the same measurement. Cost and tokens are running totals for that arm up to and including the run, not that run alone. A token total counts every billed field, cache creation included, and reads as a lower bound once a call reported no usage or reported only some of those fields; it is a count, not a price. Cost is what the provider reported, not a billing statement, and a threshold can be exceeded by the final call.\n\nA crossover says only that this schedule, on these fixtures, reached the point where discovering once had cost less. It is not a general saving; how often an application breaks a freeze is the variable, and this fixes it by construction.\n${report.budget && report.configuration.llm?.source === "llm" ? `\nReported provider cost: ${money(report.budget.measuredCostUsd)}; cost complete: ${report.budget.costComplete}; calls: ${report.budget.calls}${report.budget.stopReason ? `; stopped: ${cell(report.budget.stopReason)}` : ""}.\n` : ""}`;
}

export async function writeReport(report, directory, render = renderMarkdown) {
  await mkdir(directory, { recursive: true });
  const paths = { json: join(directory, "results.json"), markdown: join(directory, "results.md") };
  await writeFile(paths.json, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  await writeFile(paths.markdown, render(report), { flag: "wx" });
  return paths;
}
