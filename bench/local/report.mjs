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

export async function writeReport(report, directory) {
  await mkdir(directory, { recursive: true });
  const paths = { json: join(directory, "results.json"), markdown: join(directory, "results.md") };
  await writeFile(paths.json, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  await writeFile(paths.markdown, renderMarkdown(report), { flag: "wx" });
  return paths;
}
