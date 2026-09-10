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

test("filterReasonsHaveSeparateNotices: occlusion, region deduplication and quota exclusions are visible in every rendered view", () => {
  const shared = noticeRows(4, "Label", "StaticText").map(e => ({ ...e, clickable: true, clickableRegion: "shared" }));
  const quota = noticeRows(45, "Region", "StaticText").map((e, i) => ({ ...e, clickable: true, clickableRegion: `region-${i}` }));
  for (const { rows, filtered, shown } of [
    { rows: [...noticeRows(3), ...coveredNoticeRows(7)], filtered: 7, shown: 3 },
    { rows: shared, filtered: 3, shown: 1 },
    { rows: quota, filtered: 5, shown: 40 },
  ]) {
    const before = JSON.stringify(rows);
    for (const output of filterViews(rows, "inspect", 60)) {
      expect(output.split(filterNotice(filtered))).toHaveLength(2);
      expect(output).not.toContain("more elements not shown");
      expect(output).not.toContain("scroll or interact");
      expect(output.split("\n").filter(line => line.startsWith("- "))).toHaveLength(shown);
    }
    expect(JSON.stringify(rows)).toBe(before);
  }
});

test("mixedCapAndFilteringStayDistinct: cap loss and policy exclusions have separate accurate notices including a zero cap", () => {
  const rows = [...noticeRows(5), ...coveredNoticeRows(5)];
  for (const cap of [3, 0]) {
    const outputs = filterViews(rows, "inspect", cap);
    expect(outputs[2] === "").toBe(cap === 0);
    for (const output of cap === 0 ? outputs.slice(0, 2) : outputs) {
      expect(output.split(filterNotice(5))).toHaveLength(2);
      expect(output.match(/\(\+\d+ more elements not shown[^)]*\)/g)).toEqual([
        `(+${5 - cap} more elements not shown — scroll or interact to reveal them)`,
      ]);
      expect(output.split("\n").filter(line => line.startsWith("- "))).toHaveLength(cap);
      expect(output).not.toContain("Covered");
    }
  }
});
