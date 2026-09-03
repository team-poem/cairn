import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleReporter } from "../../../src/adapters/reporters/console.js";
import type { Result, RunUsage } from "../../../src/core/types.js";

// Consolidated audit coverage.

{

  const base = (usage?: RunUsage, verdict?: Result["verdict"]): Result => ({
    scenario: "checkout",
    context: { intent: "buy" },
    evidence: {
      execution: { actions: [], navigated: true, finalUrl: "https://shop/done", blocked: false },
      perception: {},
      logic: { requests: [{ method: "GET", url: "https://shop/api", status: 200 }], console: [] },
    },
    verdict: verdict ?? { passed: true, results: [{ assertion: { kind: "navigated" }, passed: true, detail: "https://shop/done" }] },
    usage,
  });

  async function lines(result: Result): Promise<string[]> {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => out.push(args.join(" ")));
    await new ConsoleReporter().emit(result);
    return out;
  }

  afterEach(() => vi.restoreAllMocks());

  // console-reporter-marks-subprocess-tokens-unmeasured.test.ts
  {
    describe("ConsoleReporter usage line", () => {
      it("consoleReporterMarksSubprocessTokensUnmeasured: calls without measurement print `tokens unmeasured (subprocess backend)`", async () => {
        const out = await lines(base({ llmCalls: 2, measuredCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }));
        expect(out).toContain("  · llm: 2 call(s) · tokens unmeasured (subprocess backend)");
      });
    });
  }

  // console-reporter-omits-tokens-for-zero-calls.test.ts
  {
    describe("ConsoleReporter usage line", () => {
      it("consoleReporterOmitsTokensForZeroCalls: a zero-call replay prints the call count alone; no usage prints no llm line at all", async () => {
        const zero = await lines(base({ llmCalls: 0, measuredCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }));
        expect(zero).toContain("  · llm: 0 call(s)");
        const none = await lines(base(undefined));
        expect(none.some((l) => l.includes("llm:"))).toBe(false);
      });
    });
  }

  // console-reporter-prints-measured-tokens.test.ts
  {
    describe("ConsoleReporter usage line", () => {
      it("consoleReporterPrintsMeasuredTokens: measured calls print in/out tokens, with the cached count only when non-zero", async () => {
        const withCache = await lines(base({ llmCalls: 3, measuredCalls: 3, inputTokens: 1200, outputTokens: 80, cacheReadTokens: 900 }));
        expect(withCache).toContain("  · llm: 3 call(s) · 1200 in (900 cached) / 80 out tokens");
        const noCache = await lines(base({ llmCalls: 1, measuredCalls: 1, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 }));
        expect(noCache).toContain("  · llm: 1 call(s) · 10 in / 2 out tokens");
      });
    });
  }

  // console-reporter-summary-line.test.ts
  {
    describe("ConsoleReporter summary", () => {
      it("consoleReporterSummaryLine: pass → `✓ pass — N assertion(s)`; fail → `✗ <detail or N issue(s)> — evidence captured`; per-assertion marks and header lines", async () => {
        const pass = await lines(base());
        expect(pass[0]).toBe("\ncheckout");
        expect(pass[1]).toBe("  ✓ navigated → https://shop/done");
        expect(pass[2]).toBe("  · 0 actions · 1 requests · 0 console msgs");
        expect(pass).toContain("  ✓ navigated — https://shop/done");
        expect(pass.at(-1)).toBe("\n✓ pass — 1 assertion(s)");

        const fail = await lines(
          base(undefined, {
            passed: false,
            results: [
              { assertion: { kind: "no-console-errors" }, passed: false, detail: "1 console error(s): boom" },
              { assertion: { kind: "no-failed-requests" }, passed: true },
            ],
          }),
        );
        expect(fail).toContain("  ✗ no-console-errors — 1 console error(s): boom");
        expect(fail).toContain("  ✓ no-failed-requests");
        expect(fail.at(-1)).toBe("\n✗ 1 issue(s) — evidence captured");

        const closed = await lines(base(undefined, { passed: false, results: [], detail: "no assertions" }));
        expect(closed.at(-1)).toBe("\n✗ no assertions — evidence captured");
      });
    });
  }

}
