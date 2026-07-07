/**
 * Pure markdown renderer for explore reports. Deliberately NOT a `Reporter` adapter —
 * `Reporter.emit` takes a verdict-shaped `Result`, and a findings report is not a verdict;
 * hosts get the `ExploreReport` object and render it with this (or their own) function.
 */
import type { ExploreReport } from "../../core/explore/index.js";
import type { Finding, FindingSeverity } from "../../core/explore/findings.js";

const SEVERITY_ORDER: FindingSeverity[] = ["error", "warn", "info"];
const SEVERITY_MARK: Record<FindingSeverity, string> = { error: "🔴", warn: "🟠", info: "ℹ️" };

function renderFinding(f: Finding): string {
  const times = f.occurrences && f.occurrences > 1 ? ` (×${f.occurrences})` : "";
  const at = f.url ? ` — at ${f.url}` : "";
  return `- **${f.kind}**${times}: ${f.detail}${at} _(step ${f.stepIndex + 1})_`;
}

export function renderExploreReport(report: ExploreReport): string {
  const bySeverity = (severity: FindingSeverity): Finding[] =>
    report.findings.filter((f) => f.severity === severity);

  const lines: string[] = [
    `# Explore report — ${report.charter}`,
    ``,
    `${report.steps.length} step(s) · ${report.visited.length} destination(s) · ${report.findings.length} finding(s)` +
      ` · llm ${report.usage.llmCalls} call(s)` +
      (report.usage.measuredCalls
        ? ` (${report.usage.inputTokens} in / ${report.usage.outputTokens} out tokens)`
        : ""),
  ];
  if (report.truncated) {
    lines.push(
      ``,
      `> ⚠ The survey stopped at its step cap before the charter was covered — the findings are real, the coverage is partial.`,
    );
  }

  lines.push(``, `## Findings`);
  if (!report.findings.length) {
    lines.push(``, `Nothing to report — no failed requests, console errors, dead actions, or observed UX problems.`);
  }
  for (const severity of SEVERITY_ORDER) {
    const group = bySeverity(severity);
    if (!group.length) continue;
    lines.push(``, `### ${SEVERITY_MARK[severity]} ${severity} (${group.length})`, ``);
    for (const f of group) lines.push(renderFinding(f));
  }

  lines.push(``, `## Coverage`, ``);
  for (const v of report.visited) lines.push(`- ${v}`);

  lines.push(``, `## Steps`, ``);
  report.steps.forEach((s, i) => lines.push(`${i + 1}. \`${JSON.stringify(s)}\``));

  return lines.join("\n") + "\n";
}
