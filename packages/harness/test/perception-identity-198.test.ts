// file: packages/harness/test/perception-identity-198.test.ts
import { test, expect, vi } from "vitest";
import * as nodeApi from "../src/index.js";
import * as browserApi from "../src/browser.js";
import { rankElements, renderRankedElements } from "../src/core/discover/prompt.js";
import { applyDecision, describeAmbiguity } from "../src/core/discover/decision.js";
import type { Decision } from "../src/core/discover/decision.js";
import type { PageElement, Step, Target } from "../src/core/types.js";
import type { Driver } from "../src/core/ports.js";
import { discover } from "../src/core/discover/index.js";
import { explore } from "../src/core/explore/index.js";
import { LlmStepHealer } from "../src/core/step-heal.js";
import { SelfHealingDriver } from "../src/adapters/drivers/self-heal.js";
import { BuiltinStepHandler } from "../src/core/steps.js";
import { ChromeDevToolsDriver } from "../src/adapters/drivers/chrome.js";
import { StubDriver, ScriptedLlm } from "./support/doubles.js";

type Observed = PageElement & { ref?: string; clickable?: boolean; clickableRegion?: string; inActivePopup?: boolean; occluded?: boolean };
type RefDecision = Decision & { ref?: string };
const normalize = (elements: Observed[]): Observed[] => {
  const fn = (nodeApi as unknown as { normalizeElements?: (e: Observed[]) => Observed[] }).normalizeElements;
  expect(fn, "normalizeElements must be a public engine policy").toBeTypeOf("function");
  return fn!(elements);
};
const apply = applyDecision as (driver: Driver, decision: RefDecision, elements?: Observed[]) => Promise<Step>;
const element = (name: string, facts: Partial<Observed> = {}): Observed => ({ role: "button", name, ...facts });
const background = (count = 70): Observed[] => Array.from({ length: count }, (_, i) => element(`Choose account ${i}`));
const observedPair = (): Observed[] => [element("Save", { ref: "turn1:first" }), element("Save", { ref: "turn1:second" })];
class RefDriver extends StubDriver {
  events: Array<{ action: string; ref?: string; target?: Target; value?: string }> = [];
  refs = new Map<string, Target>([["turn1:first", { text: "Save", role: "button", index: 0, nth: 0 }], ["turn1:second", { text: "Save", role: "button", index: 1, nth: 1 }]]);
  afterLocate?: () => void;
  override async locate(target: Target): Promise<Target> { this.events.push({ action: "legacyLocate", target }); return target; }
  async locateRef(ref: string): Promise<Target> {
    const target = this.refs.get(ref);
    if (!target) throw new Error(`stale reference: ${ref}`);
    this.events.push({ action: "locateRef", ref });
    this.afterLocate?.();
    return { ...target };
  }
  async act(action: string, target?: Target, ref?: string, value?: string): Promise<void> {
    if (ref && !this.refs.has(ref)) throw new Error(`stale reference: ${ref}`);
    this.events.push({ action, target, ref, value });
  }
  override async click(target: Target, ref?: string): Promise<void> { await this.act("click", target, ref); }
  override async doubleClick(target?: Target, ref?: string): Promise<void> { await this.act("doubleClick", target, ref); }
  override async hover(target?: Target, ref?: string): Promise<void> { await this.act("hover", target, ref); }
  override async type(target?: Target, value?: string, ref?: string): Promise<void> { await this.act("type", target, ref, value); }
  override async select(target?: Target, value?: string, ref?: string): Promise<void> { await this.act("select", target, ref, value); }
}
function chromeFixture(raw = 'uid=1_1 button "Save"\nuid=1_2 button "Save"') {
  const driver = new ChromeDevToolsDriver({ promoteClickables: false });
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let snapshot = raw;
  (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });
    return name === "take_snapshot" ? snapshot : "";
  };
  return { driver, calls, setSnapshot: (next: string) => { snapshot = next; } };
}
const chromeRef = async (driver: ChromeDevToolsDriver, index = 0): Promise<string> => {
  const rows = await driver.snapshot() as Observed[];
  expect(rows[index]?.ref, "Chrome snapshots must issue opaque observation references").toBeTypeOf("string");
  return rows[index]!.ref!;
};
const chromeLocate = (driver: ChromeDevToolsDriver, ref: string): Promise<Target> =>
  (driver as unknown as { locateRef: (ref: string) => Promise<Target> }).locateRef(ref);
const chromeClick = (driver: ChromeDevToolsDriver, target: Target, ref: string): Promise<void> =>
  (driver.click as (target: Target, ref: string) => Promise<void>).call(driver, target, ref);

test("popupSurvivesHeavyPage: active popup options survive sixty intent matching background controls", () => {
  const option = element("Personal", { role: "option", inActivePopup: true });
  const ranked = rankElements([...background(), option], "Choose account", 60);
  expect(ranked).toHaveLength(60);
  expect(ranked[0]).toBe(option);
});

test("popupEvidenceBudget: popup priority preserves five result evidence slots", () => {
  const options = Array.from({ length: 60 }, (_, i) => element(`Option ${i}`, { role: "option", inActivePopup: true }));
  const evidence = Array.from({ length: 5 }, (_, i) => element(`account saved ${i}`, { role: "StaticText" }));
  const ranked = rankElements([...background(), ...options, ...evidence], "account saved", 60);
  expect(ranked.filter(e => (e as Observed).inActivePopup)).toHaveLength(55);
  expect(ranked.filter(e => e.role === "StaticText")).toEqual(evidence);
});

test("occludedNotListed: positive occlusion excludes actions while unknown occlusion stays visible", () => {
  const hidden = element("Hidden", { occluded: true });
  const unknown = element("Unknown");
  const visible = element("Visible", { occluded: false });
  expect(rankElements([hidden, unknown, visible], "Hidden", 60)).toEqual([unknown, visible]);
});

test("popupKeepsSnapshotNth: popup survivor keeps duplicate ordinal from the full snapshot", () => {
  const first = element("Save", { ref: "first", occluded: true });
  const second = element("Save", { ref: "second", inActivePopup: true });
  const listing = renderRankedElements([first, ...background(), second], "Choose account", 1);
  expect(listing).toContain("Save");
  expect(listing).toContain("nth=1");
  expect(listing).toContain("second");
});

test("clickableRanksWithoutRoleLie: proven clickables rank with controls without inventing an ARIA role", () => {
  const clickable = element("Open details", { role: "StaticText", clickable: true, ref: "card" });
  expect(rankElements([element("Open details", { role: "StaticText" }), clickable], "", 1)).toEqual([clickable]);
  expect(renderRankedElements([clickable], "")).toContain("StaticText");
  expect(renderRankedElements([clickable], "")).toMatch(/clickable/i);
});

test("normalizeRegionDedup: one clickable marker per proven region preserves every text row", () => {
  const rows = [element("Title", { role: "StaticText", clickable: true, clickableRegion: "card" }), element("Subtitle", { role: "StaticText", clickable: true, clickableRegion: "card" })];
  const result = normalize(rows);
  expect(result.map(e => e.name)).toEqual(["Title", "Subtitle"]);
  expect(result.map(e => Boolean(e.clickable))).toEqual([true, false]);
  expect(result.map(e => e.role)).toEqual(["StaticText", "StaticText"]);
});

test("normalizeClickableQuota: supplementary clickable priority caps at forty without deleting evidence", () => {
  const rows = Array.from({ length: 41 }, (_, i) => element(`Card ${i}`, { role: "StaticText", clickable: true, clickableRegion: `region${i}` }));
  const result = normalize(rows);
  expect(result).toHaveLength(41);
  expect(result.filter(e => e.clickable)).toHaveLength(40);
  expect(result[40]?.name).toBe("Card 40");
});

test("normalizeIsPure: normalization never mutates a shared driver snapshot", () => {
  const rows = [element("First", { role: "StaticText", clickable: true, clickableRegion: "same" }), element("Second", { role: "StaticText", clickable: true, clickableRegion: "same" })];
  const before = structuredClone(rows);
  rows.forEach(Object.freeze); Object.freeze(rows);
  expect(normalize(rows).filter(e => e.clickable)).toHaveLength(1);
  expect(rows).toEqual(before);
});

test("normalizeLegacyAndEmpty: legacy observations preserve data and order and empty snapshots stay empty", () => {
  const rows = [element("Title", { role: "heading" }), element("Save", { disabled: true }), element("Email", { role: "textbox", value: "a@example.test" })];
  expect(normalize(rows)).toEqual(rows);
  expect(normalize([])).toEqual([]);
});

test("normalizeDistinctUnknownRegions: same names do not merge distinct or unknown clickable regions", () => {
  const rows = [element("Open", { role: "StaticText", clickable: true, clickableRegion: "a" }), element("Open", { role: "StaticText", clickable: true, clickableRegion: "b" }), element("Open", { role: "StaticText", clickable: true }), element("Open", { role: "StaticText", clickable: true })];
  expect(normalize(rows).filter(e => e.clickable)).toHaveLength(4);
});

test("perceptionPublicBothEntries: Node and browser consumers share the same normalization and ranking policy", () => {
  const node = nodeApi as unknown as Record<string, unknown>;
  const browser = browserApi as unknown as Record<string, unknown>;
  expect(node.normalizeElements).toBeTypeOf("function");
  expect(browser.normalizeElements).toBe(node.normalizeElements);
  expect(node.rankElements).toBe(rankElements);
  expect(browser.rankElements).toBe(rankElements);
});

test("refClickExact: reference addresses the selected duplicate for click", async () => {
  const driver = new RefDriver();
  const step = await apply(driver, { action: "click", ref: "turn1:second", text: "Save", value: "chosen" }, observedPair());
  expect(driver.events.map(e => e.action)).toEqual(["locateRef", "click"]);
  expect(driver.events[1]?.ref).toBe("turn1:second");
  expect(step).toMatchObject({ kind: "click", target: { text: "Save", role: "button", nth: 1 } });
});

test("refDoubleClickExact: reference addresses the selected duplicate for doubleClick", async () => {
  const driver = new RefDriver();
  const step = await apply(driver, { action: "doubleClick", ref: "turn1:second", text: "Save", value: "chosen" }, observedPair());
  expect(driver.events.map(e => e.action)).toEqual(["locateRef", "doubleClick"]);
  expect(driver.events[1]?.ref).toBe("turn1:second");
  expect(step).toMatchObject({ kind: "doubleClick", target: { text: "Save", role: "button", nth: 1 } });
});

test("refHoverExact: reference addresses the selected duplicate for hover", async () => {
  const driver = new RefDriver();
  const step = await apply(driver, { action: "hover", ref: "turn1:second", text: "Save", value: "chosen" }, observedPair());
  expect(driver.events.map(e => e.action)).toEqual(["locateRef", "hover"]);
  expect(driver.events[1]?.ref).toBe("turn1:second");
  expect(step).toMatchObject({ kind: "hover", target: { text: "Save", role: "button", nth: 1 } });
});

test("refTypeExact: reference addresses the selected duplicate for type", async () => {
  const driver = new RefDriver();
  const step = await apply(driver, { action: "type", ref: "turn1:second", text: "Save", value: "chosen" }, observedPair());
  expect(driver.events.map(e => e.action)).toEqual(["locateRef", "type"]);
  expect(driver.events[1]?.ref).toBe("turn1:second");
  expect(step).toMatchObject({ kind: "type", target: { text: "Save", role: "button", nth: 1 } });
});

test("refSelectExact: reference addresses the selected duplicate for select", async () => {
  const driver = new RefDriver();
  const step = await apply(driver, { action: "select", ref: "turn1:second", text: "Save", value: "chosen" }, observedPair());
  expect(driver.events.map(e => e.action)).toEqual(["locateRef", "select"]);
  expect(driver.events[1]?.ref).toBe("turn1:second");
  expect(step).toMatchObject({ kind: "select", target: { text: "Save", role: "button", nth: 1 } });
});

test("refOnlyDecision: a reference alone supplies canonical target metadata", async () => {
  const driver = new RefDriver();
  const step = await apply(driver, { action: "click", ref: "turn1:second" }, observedPair());
  expect(step).toMatchObject({ kind: "click", target: { text: "Save", role: "button", nth: 1 } });
  expect(driver.events[1]?.ref).toBe("turn1:second");
});

test("refUnknownRejected: untrusted reference is rejected before driver interaction", async () => {
  const driver = new RefDriver();
  await expect(apply(driver, { action: "click", ref: "invented", text: "Save" }, observedPair())).rejects.toThrow(/ref|reference|snapshot/i);
  expect(driver.events).toEqual([]);
});

test("refDuplicateRejected: untrusted reference is rejected before driver interaction", async () => {
  const driver = new RefDriver();
  await expect(apply(driver, { action: "click", ref: "turn1:second", text: "Save" }, [...observedPair(), observedPair()[1]!])).rejects.toThrow(/ref|reference|snapshot/i);
  expect(driver.events).toEqual([]);
});
