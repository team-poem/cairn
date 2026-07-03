/** Human-readable Reporter for CLI/CI. Mirrors the report sketch in docs/design.md §7. */
import type { Reporter } from "../../core/ports.js";
import type { Result } from "../../core/types.js";

export class ConsoleReporter implements Reporter {
  async emit(result: Result): Promise<void> {
    const { scenario, evidence, verdict } = result;
    const mark = (ok: boolean) => (ok ? "✓" : "✗");

    console.log(`\n${scenario}`);
    console.log(`  ${mark(evidence.execution.navigated)} navigated → ${evidence.execution.finalUrl ?? "(none)"}`);
    console.log(`  · ${evidence.execution.actions.length} actions · ${evidence.logic.requests.length} requests · ${evidence.logic.console.length} console msgs`);

    for (const r of verdict.results) {
      console.log(`  ${mark(r.passed)} ${r.assertion.kind}${r.detail ? ` — ${r.detail}` : ""}`);
    }

    const failed = verdict.results.filter((r) => !r.passed).length;
    console.log(
      verdict.passed
        ? `\n${mark(true)} pass — ${verdict.results.length} assertion(s)`
        : `\n${mark(false)} ${verdict.detail ?? `${failed} issue(s)`} — evidence captured`,
    );
  }
}
