import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const cell = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");

export function renderMarkdown(report) {
  const rows = report.summaries.map((summary) => {
    const records = report.records.filter((record) => record.tier === summary.tier && record.mode === summary.mode);
    const calls = records.every((record) => record.usage !== null) ? records.reduce((n, record) => n + record.usage.llmCalls, 0) : "unknown";
    const elapsed = records.length ? (records.reduce((n, record) => n + record.elapsedMs, 0) / records.length).toFixed(0) : "n/a";
    return `| ${cell(summary.tier)} | ${cell(summary.mode)} | ${summary.requested} | ${summary.attempted} | ${summary.completed} | ${summary.failures} | ${summary.failureRate === null ? "n/a" : (summary.failureRate * 100).toFixed(1) + "%"} | ${calls} | ${elapsed} |`;
  });
  const sources = [...new Set(report.records.map((record) => record.source?.kind ?? "unknown"))].join(", ");
  return `# Local benchmark\n\n${report.incomplete ? "INCOMPLETE: " + cell(report.stopReason) : "Requested attempts completed."}\n\nEngine: ${cell(report.engine.version)} at ${cell(report.engine.commit)} (dirty: ${report.engine.dirty}).\nBuild SHA-256: ${cell(report.engine.buildHash)}.\nConfiguration SHA-256: ${report.configHash}.\nMeasured: ${report.startedAt} → ${report.finishedAt}.\nCapture/discovery sources: ${cell(sources)}. Execution LLM source: ${cell(report.configuration.mode === "replay" ? "none (replay)" : report.configuration.llm?.source ?? "unknown")}.\n\n| Tier | Mode | Requested | Attempted | Engine returned | Failures | Failure rate | LLM calls | Average ms |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows.join("\n")}\n\nFailures use all attempted runs as their denominator, including exceptions. Elapsed time includes resource startup and awaited cleanup. Requested delays and observed times are distinct fields in JSON.\n\nEngine journey, verdict, proof and fixture completion are separate observations in JSON. A green engine verdict cannot override an incomplete fixture. Zero LLM calls on a successful v2 run indicate unaided survival; repair counts alone do not describe outcome rediscovery.\n\nRepeated replay measures these captures under this configuration, not discovery success or general application coverage. Scripted discovery is smoke verification and must not be pooled with actual LLM discovery.\n${report.budget ? `\nReported provider cost: $${report.budget.measuredCostUsd.toFixed(6)}; cost complete: ${report.budget.costComplete}. This is reported cost, not a strict billing cap; a threshold can be exceeded by the final call.\n` : ""}`;
}

export async function writeReport(report, directory) {
  await mkdir(directory, { recursive: true });
  const paths = { json: join(directory, "results.json"), markdown: join(directory, "results.md") };
  await writeFile(paths.json, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  await writeFile(paths.markdown, renderMarkdown(report), { flag: "wx" });
  return paths;
}
