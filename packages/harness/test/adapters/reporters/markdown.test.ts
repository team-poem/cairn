import { describe, expect, it } from "vitest";
import { renderExploreReport } from "../../../src/adapters/reporters/markdown.js";
import type { ExploreReport } from "../../../src/core/explore/index.js";
import { emptyUsage } from "../../../src/core/usage.js";

const report = (over: Partial<ExploreReport> = {}): ExploreReport => ({
  charter: "survey checkout",
  visited: ["shop/cart", "shop/checkout"],
  steps: [
    { kind: "goto", url: "https://shop/cart" },
    { kind: "click", target: { text: "Checkout" } },
  ],
  findings: [
    { kind: "agent-note", severity: "info", detail: "two identical Continue buttons", key: "n1", stepIndex: 1 },
    { kind: "failed-request", severity: "error", detail: "500 POST /api/order", key: "f1", stepIndex: 1, url: "https://shop/checkout", occurrences: 3 },
    { kind: "action-error", severity: "warn", detail: "click did nothing", key: "a1", stepIndex: 1 },
  ],
  usage: { ...emptyUsage(), llmCalls: 4, measuredCalls: 4, inputTokens: 1200, outputTokens: 80 },
  truncated: false,
  ...over,
});

describe("renderExploreReport", () => {
  it("renders the header counts and usage", () => {
    const md = renderExploreReport(report());
    expect(md).toContain("# Explore report — survey checkout");
    expect(md).toContain("2 step(s) · 2 destination(s) · 3 finding(s) · llm 4 call(s) (1200 in / 80 out tokens)");
  });

  it("groups findings by severity in error → warn → info order, with occurrences and location", () => {
    const md = renderExploreReport(report());
    const error = md.indexOf("### 🔴 error (1)");
    const warn = md.indexOf("### 🟠 warn (1)");
    const info = md.indexOf("### ℹ️ info (1)");
    expect(error).toBeGreaterThan(-1);
    expect(error).toBeLessThan(warn);
    expect(warn).toBeLessThan(info);
    expect(md).toContain("- **failed-request** (×3): 500 POST /api/order — at https://shop/checkout _(step 2)_");
  });

  it("flags a truncated survey and says coverage is partial", () => {
    const md = renderExploreReport(report({ truncated: true }));
    expect(md).toContain("stopped at its step cap");
  });

  it("says so when there is nothing to report", () => {
    const md = renderExploreReport(report({ findings: [] }));
    expect(md).toContain("Nothing to report");
    expect(md).not.toContain("### 🔴");
  });

  it("lists coverage and numbered steps as the reproduction trail", () => {
    const md = renderExploreReport(report());
    expect(md).toContain("## Coverage\n\n- shop/cart\n- shop/checkout");
    expect(md).toContain('1. `{"kind":"goto","url":"https://shop/cart"}`');
    expect(md).toContain("2. `");
  });

  it("omits the token detail when no call was measured", () => {
    const md = renderExploreReport(report({ usage: { ...emptyUsage(), llmCalls: 2 } }));
    expect(md).toContain("llm 2 call(s)");
    expect(md).not.toContain("tokens)");
  });
});
