// file: packages/harness/test/core/perception-omission-count.test.ts
import { expect, test } from "vitest";
import { PerceptionObservation } from "../../src/core/observation.js";
import { renderRankedElements } from "../../src/core/discover/prompt.js";
import { discover } from "../../src/core/discover/index.js";
import { explore } from "../../src/core/explore/index.js";
import type { LlmClient } from "../../src/core/ports.js";
import type { PageElement, Target } from "../../src/core/types.js";
import { StubDriver } from "../support/doubles.js";

class OmissionDriver extends StubDriver {
  async locateRef(ref: string): Promise<Target> { return { selector: `#${ref}` }; }
}
const omittedNotice = /\(\+\d+ more elements not shown[^)]*\)/g;
function numberedRows(count: number, role = "button", prefix = "Control"): PageElement[] {
  return Array.from({ length: count }, (_, i) => ({ role, name: `${prefix} ${i}`, ref: `${prefix}-${i}` }));
}
function coveredRows(count: number): PageElement[] {
  return numberedRows(count, "StaticText", "Covered").map(e => ({ ...e, clickable: true, occluded: true }));
}
function sharedRegionRows(count: number): PageElement[] {
  return numberedRows(count, "StaticText", "Label").map(e => ({ ...e, clickable: true, clickableRegion: "shared" }));
}
function renderedViews(rows: PageElement[], intent: string, limit: number): string[] {
  const driver = new OmissionDriver();
  const page = new PerceptionObservation(driver, rows, rows, intent, limit);
  return [renderRankedElements(rows, intent, limit), page.render, page.references];
}

test("filteredRowsDoNotSendLoopsSearching: discover and explore receive no false truncation notice for policy-filtered rows", async () => {
  for (const mode of ["discover", "explore"] as const) {
    const driver = new OmissionDriver();
    driver.els = [...numberedRows(1), ...coveredRows(50), ...sharedRegionRows(120)];
    const prompts: string[] = [];
    const llm: LlmClient = {
      id: "omission-scripted",
      async complete(prompt) {
        if (!prompt.includes("What is the single next action?")) return "[]";
        prompts.push(prompt);
        return '{"action":"done"}';
      },
    };
    const options = { driver, llm, baseUrl: "https://app/start", maxSteps: 1 };
    const result = mode === "discover" ? await discover("inspect", options) : await explore("inspect", options);
    expect(result.truncated).not.toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("[button] Control 0");
    expect(prompts[0]).toContain("[StaticText] Label 0");
    expect(prompts[0]?.match(/ref="[^"]+"/g)).toHaveLength(2);
    expect(prompts[0]).not.toContain("more elements not shown");
  }
});

test("filteredRowsAreNotCapOmissions: occlusion, region deduplication and promotion quotas do not produce truncation notices", () => {
  const beyondQuota = numberedRows(45, "StaticText", "Region").map((e, i) => ({ ...e, clickable: true, clickableRegion: `region-${i}` }));
  for (const filtered of [coveredRows(50), sharedRegionRows(120), beyondQuota]) {
    const rows = [...numberedRows(1), ...filtered];
    const before = JSON.stringify(rows);
    for (const output of renderedViews(rows, "inspect", 60)) {
      expect(output).toContain("[button] Control 0");
      expect(output).not.toContain("more elements not shown");
    }
    expect(JSON.stringify(rows)).toBe(before);
  }
});
