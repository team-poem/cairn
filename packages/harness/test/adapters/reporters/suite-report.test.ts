import { describe, expect, it } from "vitest";
import { renderSuiteReport } from "../../../src/adapters/reporters/suite.js";
import type { SuiteResult, SuiteVerdict } from "../../../src/suite.js";
import { emptyUsage } from "../../../src/core/usage.js";

const verdict = (over: Partial<SuiteVerdict> = {}): SuiteVerdict => ({
  id: "catalog",
  intent: "open the catalog",
  verdict: { passed: true, results: [{ assertion: { kind: "navigated" }, passed: true }] },
  skillRef: "skills/catalog.skill.json",
  discovered: false,
  heals: 0,
  usage: emptyUsage(),
  ...over,
});

describe("renderSuiteReport", () => {
  it("renders a passing suite with the free-replay count", () => {
    const suite: SuiteResult = {
      verdicts: [verdict(), verdict({ id: "cart", intent: "add to cart", discovered: true, usage: { ...emptyUsage(), llmCalls: 3 } })],
      passed: true,
      usage: { ...emptyUsage(), llmCalls: 3 },
    };
    const md = renderSuiteReport(suite);
    expect(md).toContain("✓ PASS — 2/2 case(s) passed · llm 3 call(s) total · 1 case(s) replayed with zero LLM calls");
    expect(md).toContain("| catalog | ✓ pass | replayed (cached) |  |  |");
    expect(md).toContain("| cart | ✓ pass | discovered + replayed |  | 3 |");
    expect(md).not.toContain("## Failures");
  });

  it("renders failures with the verdict detail and the failing assertions", () => {
    const failing = verdict({
      id: "pay",
      intent: "pay for the cart",
      heals: 1,
      verdict: {
        passed: false,
        detail: "step 2/3 blocked: element not found: Pay (1 later step(s) never ran)",
        results: [{ assertion: { kind: "request-status", urlIncludes: "/api/pay", status: 200 }, passed: false, detail: "no request matching /api/pay" }],
      },
    });
    const suite: SuiteResult = { verdicts: [verdict(), failing], passed: false, usage: emptyUsage() };
    const md = renderSuiteReport(suite);
    expect(md).toContain("✗ FAIL — 1/2 case(s) passed");
    expect(md).toContain("| pay | ✗ fail | replayed (cached) | 1 |  |");
    expect(md).toContain("## Failures");
    expect(md).toContain("### ✗ pay — pay for the cart");
    expect(md).toContain("step 2/3 blocked");
    expect(md).toContain("- **request-status**: no request matching /api/pay");
  });

  it("labels a truncated discovery as its own path", () => {
    const md = renderSuiteReport({ verdicts: [verdict({ discovered: true, truncated: true, verdict: { passed: false, results: [] } })], passed: false, usage: emptyUsage() });
    expect(md).toContain("| catalog | ✗ fail | discovery truncated |");
  });
});
