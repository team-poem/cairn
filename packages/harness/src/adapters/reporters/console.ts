/** Human-readable Reporter for CLI/CI. Mirrors the report sketch in docs/design.md §7. */
import type { Reporter } from "../../core/ports.js";
import type { Result, VerdictProof } from "../../core/types.js";

export class ConsoleReporter implements Reporter {
  async emit(result: Result): Promise<void> {
    const { scenario, evidence, verdict } = result;
    const mark = (ok: boolean) => (ok ? "✓" : "✗");

    console.log(`\n${scenario}`);
    console.log(`  ${mark(evidence.execution.navigated)} navigated → ${evidence.execution.finalUrl ?? "(none)"}`);
    console.log(`  · ${evidence.execution.actions.length} actions · ${evidence.logic.requests.length} requests · ${evidence.logic.console.length} console msgs`);
    const u = result.usage;
    if (u) {
      const tokens = u.measuredCalls
        ? ` · ${u.inputTokens} in${u.cacheReadTokens ? ` (${u.cacheReadTokens} cached)` : ""} / ${u.outputTokens} out tokens`
        : u.llmCalls
          ? " · tokens unmeasured (subprocess backend)"
          : "";
      console.log(`  · llm: ${u.llmCalls} call(s)${tokens}`);
    }

    for (const r of verdict.results) {
      console.log(`  ${mark(r.passed)} ${r.assertion.kind}${r.detail ? ` — ${r.detail}` : ""}`);
    }

    const failed = verdict.results.filter((r) => !r.passed).length;
    console.log(
      verdict.passed
        ? `\n${mark(true)} pass — ${verdict.results.length} assertion(s)${proofLabel(verdict.proof)}`
        : `\n${mark(false)} ${verdict.detail ?? `${failed} issue(s)`} — evidence captured${verdict.failure ? ` [${verdict.failure}]` : ""}`,
    );
  }
}

/** What the green proves, in one clause (#197): the grade, then what would have to break. */
function proofLabel(p: VerdictProof | undefined): string {
  if (!p) return "";
  const grade =
    p.grade === "work" ? `proves the action fired (${p.work} check${p.work === 1 ? "" : "s"})`
    : p.grade === "judged" ? "an LLM judged the outcome — nothing mechanical checks the action"
    : p.grade === "arrival" ? "proves arrival only — the action itself is unchecked"
    : "proves nothing about the flow — a flow that quietly did nothing would pass";
  const extras = [
    p.vacuous ? `${p.vacuous} vacuous` : "",
    p.unprovenAction ? `unproven: ${p.unprovenAction}` : "",
  ].filter(Boolean);
  return ` · ${grade}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}
