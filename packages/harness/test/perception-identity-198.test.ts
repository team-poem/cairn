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
