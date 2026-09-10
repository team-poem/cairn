// file: packages/harness/test/core/perception-filter-notice.test.ts
import { expect, test } from "vitest";
import { PerceptionObservation } from "../../src/core/observation.js";
import { renderRankedElements } from "../../src/core/discover/prompt.js";
import { discover } from "../../src/core/discover/index.js";
import { explore } from "../../src/core/explore/index.js";
import type { LlmClient } from "../../src/core/ports.js";
import type { PageElement, Target } from "../../src/core/types.js";
import { StubDriver } from "../support/doubles.js";

class FilterNoticeDriver extends StubDriver {
  async locateRef(ref: string): Promise<Target> { return { selector: `#${ref}` }; }
}
function noticeRows(count: number, prefix = "Control", role = "button"): PageElement[] {
  return Array.from({ length: count }, (_, i) => ({ name: `${prefix} ${i}`, role, ref: `${prefix}-${i}` }));
}
function coveredNoticeRows(count: number): PageElement[] {
  return noticeRows(count, "Covered", "StaticText").map(e => ({ ...e, occluded: true }));
}
function filterNotice(count: number): string {
  return `(${count} candidates excluded by visibility or region filtering; this listing is not a complete page inventory.)`;
}
function filterViews(rows: PageElement[], intent: string, limit: number): string[] {
  const page = new PerceptionObservation(new FilterNoticeDriver(), rows, rows, intent, limit);
  return [renderRankedElements(rows, intent, limit), page.render, page.references];
}

test("filteredCandidatesReachDecisionPrompts: discover and explore disclose policy exclusions without inventing scroll targets", async () => {
  for (const mode of ["discover", "explore"] as const) {
    const driver = new FilterNoticeDriver();
    driver.els = [...noticeRows(3), ...coveredNoticeRows(7)];
    const prompts: string[] = [];
    const llm: LlmClient = { id: "filtered-notice-scripted", async complete(prompt) {
      if (!prompt.includes("What is the single next action?")) return "[]";
      prompts.push(prompt);
      return '{"action":"done"}';
    } };
    const options = { driver, llm, baseUrl: "https://app/start", maxSteps: 1 };
    const result = mode === "discover" ? await discover("inspect", options) : await explore("inspect", options);
    expect(result.truncated).not.toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.split(filterNotice(7))).toHaveLength(3);
    expect(prompts[0]).not.toContain("more elements not shown");
    expect(prompts[0]).not.toContain("Covered");
    expect(prompts[0]!.match(/ref="[^"]+"/g)).toHaveLength(3);
  }
});
