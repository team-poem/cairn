import { expect, it } from "vitest";
import { rankElements } from "../../src/core/perception.js";
import { PerceptionObservation } from "../../src/core/observation.js";
import { applyDecision } from "../../src/core/discover/decision.js";
import { StubDriver } from "../support/doubles.js";
import type { PageElement, Target } from "../../src/core/types.js";

const label = (name: string, region: string, popup = false): PageElement => ({ role: "StaticText", name, clickable: true, clickableRegion: region, ...(popup ? { inActivePopup: true } : {}) });

it("allocates clickable promotion to active popup before 40 background regions", () => {
  const popup = label("Popup action", "popup", true);
  const rows = [...Array.from({ length: 40 }, (_, i) => label(`Background ${i}`, `background-${i}`)), popup];
  expect(rankElements(rows, "choose", 1)).toEqual([popup]);
  expect(rankElements(rows, "choose", 60)).toContain(popup);
});

it("keeps success evidence from a non-representative clickable sibling", () => {
  const success = label("Saved successfully", "card");
  const rows = [label("Card action", "card"), success, ...Array.from({ length: 80 }, (_, i) => ({ role: "button", name: `Button ${i}` }))];
  const ranked = rankElements(rows, "saved successfully", 60);
  expect(ranked).toContain(success);
  expect(ranked).toHaveLength(60);
});

it("keeps success evidence from a clickable region beyond its promotion budget", () => {
  const success = label("Saved successfully", "region-40");
  const rows = [...Array.from({ length: 40 }, (_, i) => label(`Card ${i}`, `region-${i}`)), success, ...Array.from({ length: 80 }, (_, i) => ({ role: "button", name: `Button ${i}` }))];
  for (const limit of [1, 60]) {
    const ranked = rankElements(rows, "saved successfully", limit);
    expect(ranked).toContain(success);
    expect(ranked).toHaveLength(limit);
  }
});

it("retains intent evidence from siblings and surplus regions without mutating source rows", () => {
  const rows = [label("First", "same"), label("Sibling", "same"), ...Array.from({ length: 41 }, (_, i) => label(`Card ${i}`, `region-${i}`))];
  const before = JSON.stringify(rows);
  const ranked = rankElements(rows, "first sibling card", 100);
  expect(ranked).toHaveLength(rows.length);
  expect(ranked[0]).toBe(rows[0]);
  expect(ranked.indexOf(rows[1]!)).toBeGreaterThan(ranked.indexOf(rows[40]!));
  expect(JSON.stringify(rows)).toBe(before);
  for (const row of ranked) expect(rows.includes(row)).toBe(true);
});

it("preserves exact original refs and duplicate ordinals for a demoted evidence sibling", async () => {
  const rows = [label("Saved", "card"), { ...label("Saved", "card"), ref: "original-second" }, ...Array.from({ length: 80 }, (_, i) => ({ role: "button", name: `Button ${i}` }))];
  class ExactDriver extends StubDriver {
    refs: string[] = [];
    async locateRef(ref: string): Promise<Target> { expect(ref).toBe("original-second"); return { text: "Saved", role: "StaticText", nth: 1, selector: "#second" }; }
    override async click(_target: Target, ref?: string) { this.refs.push(ref!); }
  }
  const driver = new ExactDriver();
  const page = new PerceptionObservation(driver, rows, rows, "saved");
  expect(page.references).toContain("(nth=1)");
  const ref = page.references.match(/ref="([^"]+)"/)![1]!;
  const decision = page.bind({ action: "click", ref });
  expect(decision.nth).toBe(1);
  await applyDecision(driver, decision);
  expect(driver.refs).toEqual(["original-second"]);
});
