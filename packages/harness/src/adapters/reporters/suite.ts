/**
 * Pure markdown renderer for suite results. Not a `Reporter` adapter — that port is per-run
 * (`Result`-shaped); a suite summary spans runs. Hosts get the `SuiteResult` object and this
 * (or their own) renderer.
 */
import type { SuiteResult, SuiteVerdict } from "../../suite.js";

function pathLabel(v: SuiteVerdict): string {
  if (v.truncated) return "discovery truncated";
  if (v.discovered) return "discovered + replayed";
  return "replayed (cached)";
}

/** Same wording as the `cairn suite` line: a green with this note proved the page, not the action. */
export function unprovenLabel(v: SuiteVerdict): string {
  return v.unprovenAction ? ` · ⚠ unproven action: ${v.unprovenAction}` : "";
}

/** Shared by the CLI progress line and report, independently of any surviving request proof. */
export function navigationEvidenceLabel(v: SuiteVerdict): string {
  return v.observedBeforeLastMutation?.length
    ? ` · ⚠ destination observed before last mutation: ${v.observedBeforeLastMutation.join(", ")} (advisory)`
    : "";
}

export function renderSuiteReport(suite: SuiteResult): string {
  const passed = suite.verdicts.filter((v) => v.verdict.passed).length;
  const failed = suite.verdicts.length - passed;
  // The engine's economics, proven per run: cached cases that needed no LLM at all.
  const freeReplays = suite.verdicts.filter((v) => !v.discovered && v.usage.llmCalls === 0).length;

  const lines: string[] = [
    `# Suite report`,
    ``,
    `${suite.passed ? "✓ PASS" : "✗ FAIL"} — ${passed}/${suite.verdicts.length} case(s) passed` +
      ` · llm ${suite.usage.llmCalls} call(s) total` +
      (freeReplays ? ` · ${freeReplays} case(s) replayed with zero LLM calls` : ""),
    ``,
    `| case | verdict | path | heals | llm calls |`,
    `| --- | --- | --- | --- | --- |`,
  ];
  for (const v of suite.verdicts) {
    lines.push(
      `| ${v.id} | ${v.verdict.passed ? "✓ pass" : "✗ fail"} | ${pathLabel(v)}${unprovenLabel(v)}${navigationEvidenceLabel(v)} | ${v.heals || ""} | ${v.usage.llmCalls || ""} |`,
    );
  }

  if (failed) {
    lines.push(``, `## Failures`);
    for (const v of suite.verdicts.filter((x) => !x.verdict.passed)) {
      lines.push(``, `### ✗ ${v.id} — ${v.intent}`);
      if (v.verdict.detail) lines.push(``, `${v.verdict.detail}`);
      for (const r of v.verdict.results.filter((x) => !x.passed)) {
        lines.push(`- **${r.assertion.kind}**${r.detail ? `: ${r.detail}` : ""}`);
      }
    }
  }

  return lines.join("\n") + "\n";
}
