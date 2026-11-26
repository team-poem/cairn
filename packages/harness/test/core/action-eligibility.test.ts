import { describe, expect, it } from "vitest";
import { discover } from "../../src/core/discover/index.js";
import { explore } from "../../src/core/explore/index.js";
import { LlmStepHealer } from "../../src/core/step-heal.js";
import { SelfHealingDriver } from "../../src/adapters/drivers/self-heal.js";
import { startTrace } from "../../src/core/trace.js";
import type { LlmClient, PerceptionAdapter } from "../../src/core/ports.js";
import type { ActionEligibility, PageElement, Target } from "../../src/core/types.js";
import { StubDriver } from "../support/doubles.js";

class RefDriver extends StubDriver {
  readonly acted: string[] = [];
  constructor(rows: PageElement[], private readonly refs = true) {
    super();
    this.els = rows;
    if (!refs) (this as { locateRef?: unknown }).locateRef = undefined;
  }
  async locateRef(ref: string): Promise<Target> {
    const row = this.els.find(e => e.ref === ref);
    if (!row) throw new Error("unknown driver ref");
    return { text: row.name, role: row.role };
  }
  override async click(target: Target): Promise<void> { this.acted.push(`click:${target.text}`); }
  override async hover(target?: Target): Promise<void> { this.acted.push(`hover:${target?.text}`); }
  override async type(target?: Target): Promise<void> { this.acted.push(`type:${target?.text}`); }
}
const link = (extra: Partial<PageElement> = {}): PageElement => ({ role: "link", name: "Alpha Curated goods from the Alpha store", ref: "n-link", ...extra });
const heading = (actions?: unknown, extra: Partial<PageElement> = {}): PageElement =>
  ({ role: "heading", name: "Alpha", ref: "n-heading", ...(actions !== undefined ? { actions: actions as ActionEligibility } : {}), ...extra });

/** Replies with `choices` in order, picking each named row's ref from the prompt it is shown. */
function scripted(choices: { action: string; row: "heading" | "link"; value?: string }[]): { llm: LlmClient; prompts: string[] } {
  const prompts: string[] = [];
  return { prompts, llm: { id: "eligibility", async complete(prompt) {
    if (!/single next action|best matches the original target/.test(prompt)) return "[]";
    prompts.push(prompt);
    const next = choices[prompts.length - 1];
    if (!next) return '{"action":"done"}';
    const ref = prompt.split("\n").find(line => line.includes(`[${next.row}]`) && line.includes("ref="))?.match(/ref="([^"]+)"/)?.[1];
    return JSON.stringify({ action: next.action, ref, ...(next.value ? { value: next.value } : {}) });
  } } };
}
const loops = {
  discover: (driver: RefDriver, llm: LlmClient, extra = {}) => discover("open alpha", { driver, llm, baseUrl: "https://app/", maxSteps: 5, ...extra }),
  explore: (driver: RefDriver, llm: LlmClient, extra = {}) => explore("survey", { driver, llm, baseUrl: "https://app/", maxSteps: 5, ...extra }),
};

describe("action eligibility", () => {
  for (const [mode, run] of Object.entries(loops)) {
    it(`rejectedContextRowRecovers [${mode}]: a disallowed heading click never dispatches and the next decision picks the link`, async () => {
      const driver = new RefDriver([link(), heading({ click: "disallowed" })]);
      const { llm, prompts } = scripted([{ action: "click", row: "heading" }, { action: "click", row: "link" }]);
      const gates: unknown[] = [];
      const trace = startTrace({ emit: e => { if (e.kind === "gate") gates.push(e.payload); } }, "t").scope("eligibility");
      await run(driver, llm, { trace });
      expect(driver.acted).toEqual(["click:Alpha Curated goods from the Alpha store"]);
      expect(prompts[1]).toContain("not run: the observed target is measured as not accepting \"click\"");
      expect(prompts[1]).toContain("nothing was redirected");
      expect(gates).toEqual([{ gate: "action-eligibility", action: "click", reason: "measured-disallowed" }]);
    });
  }

  it("unknownEligibilityStaysUsable: no measurement, an empty or partial fact, clickable false and legacy shapes all dispatch", async () => {
    for (const row of [heading(), heading({}), heading({ hover: "disallowed" }), heading({ click: "supported" }),
      heading(undefined, { clickable: false }), heading("disallowed"), heading(null), heading({ click: "Disallowed" }), heading({ click: true })]) {
      const driver = new RefDriver([link(), row]);
      await loops.discover(driver, scripted([{ action: "click", row: "heading" }]).llm);
      expect(driver.acted).toEqual(["click:Alpha"]);
    }
  });

  it("inheritedPropertyIsUnknown: a prototype-supplied fact is not a measurement", async () => {
    const driver = new RefDriver([link(), heading(Object.create({ click: "disallowed" }))]);
    await loops.discover(driver, scripted([{ action: "click", row: "heading" }]).llm);
    expect(driver.acted).toEqual(["click:Alpha"]);
  });

  it("actionSpecificRestriction: a click restriction blocks click only, not hover, type or select", async () => {
    const driver = new RefDriver([heading({ click: "disallowed" })]);
    const { llm } = scripted([
      { action: "click", row: "heading" }, { action: "hover", row: "heading" }, { action: "type", row: "heading", value: "x" },
      { action: "select", row: "heading", value: "x" },
    ]);
    await loops.discover(driver, llm);
    expect(driver.acted).toEqual(["hover:Alpha", "type:Alpha"]);
  });

  it("duplicateNamesAndRotatingRefs: eligibility follows the bound ref, never the name or a previous observation", async () => {
    const first = heading(undefined, { ref: "d1" });
    const second = heading({ click: "disallowed" }, { ref: "d2" });
    const driver = new RefDriver([first, second]);
    const prompts: string[] = [];
    const llm: LlmClient = { id: "dup", async complete(prompt) {
      if (!prompt.includes("What is the single next action?")) return "[]";
      prompts.push(prompt);
      const lines = prompt.split("\n").filter(l => l.includes("[heading] Alpha"));
      if (prompts.length === 1) return JSON.stringify({ action: "click", ref: lines[0]!.match(/ref="([^"]+)"/)![1] });
      if (prompts.length === 2) { return JSON.stringify({ action: "click", ref: lines[1]!.match(/ref="([^"]+)"/)![1] }); }
      return '{"action":"done"}';
    } };
    await loops.discover(driver, llm);
    // Turn 1 addressed the unmeasured duplicate and ran; turn 2 addressed the disallowed one and was refused.
    expect(driver.acted).toEqual(["click:Alpha"]);
    expect(prompts[2]).toContain("not run");
    // A later snapshot that no longer carries the fact makes the same row usable again.
    driver.els = [{ ...second, actions: undefined }];
    const again = scripted([{ action: "click", row: "heading" }]);
    await loops.discover(driver, again.llm);
    expect(driver.acted).toEqual(["click:Alpha", "click:Alpha"]);
  });

  it("legacyDriverWithoutRefs: facts on rows a Driver cannot address by ref are not consulted", async () => {
    const driver = new RefDriver([heading({ click: "disallowed" })], false);
    let turn = 0;
    const llm: LlmClient = { id: "named", async complete(prompt) {
      if (!prompt.includes("What is the single next action?")) return "[]";
      return ++turn === 1 ? '{"action":"click","text":"Alpha","role":"heading"}' : '{"action":"done"}';
    } };
    await loops.discover(driver, llm);
    expect(driver.acted).toEqual(["click:Alpha"]);
  });

  it("hostPerceiveSuppliesFacts: a perceive adapter may attach measurements and the same rule applies", async () => {
    const driver = new RefDriver([link(), heading()]);
    const perceive: PerceptionAdapter = rows => rows.map(r => r.role === "heading" ? { ...r, actions: { click: "disallowed" } } : r);
    await loops.discover(driver, scripted([{ action: "click", row: "heading" }, { action: "click", row: "link" }]).llm, { perceive });
    expect(driver.acted).toEqual(["click:Alpha Curated goods from the Alpha store"]);
  });

  it("repeatedRejectionStopsLoop: repeated disallowed choices stop as truncated without dispatch or more model calls", async () => {
    const driver = new RefDriver([heading({ click: "disallowed" })]);
    const { llm, prompts } = scripted(Array.from({ length: 10 }, () => ({ action: "click", row: "heading" })));
    const scenario = await loops.discover(driver, llm);
    expect(driver.acted).toEqual([]);
    expect(scenario.truncated).toBe(true);
    expect(prompts).toHaveLength(3);
    const run = scripted(Array.from({ length: 10 }, () => ({ action: "click", row: "heading" })));
    const report = await loops.explore(new RefDriver([heading({ click: "disallowed" })]), run.llm);
    expect(report.truncated).toBe(true);
    expect(run.prompts).toHaveLength(3);
  });

  it("stepRepairDeclinesDisallowed: model-driven step repair applies the same interpretation and never redirects", async () => {
    const step = { kind: "click", target: { text: "Old" }, intent: "open alpha" } as const;
    const blocked = new RefDriver([link(), heading({ click: "disallowed" })]);
    const healer = new LlmStepHealer(scripted([{ action: "click", row: "heading" }]).llm);
    expect(await healer.heal(step, 0, blocked)).toBeNull();
    expect(blocked.acted).toEqual([]);
    const allowed = new RefDriver([link(), heading()]);
    const healed = await new LlmStepHealer(scripted([{ action: "click", row: "heading" }]).llm).heal(step, 0, allowed);
    expect(healed?.step).toMatchObject({ kind: "click", target: { text: "Alpha" } });
  });

  it("locatorRepairRejectsDisallowed: the self-healing driver refuses a disallowed choice before dispatch", async () => {
    class Broken extends RefDriver {
      override async click(target: Target, ref?: string): Promise<void> {
        if (ref === undefined) throw Object.assign(new Error("element not found"), { kind: "resolution" });
        await super.click(target);
      }
    }
    const make = (row: PageElement) => new SelfHealingDriver(new Broken([link(), row]), scripted([{ action: "click", row: "heading" }]).llm);
    const blocked = make(heading({ click: "disallowed" }));
    await expect(blocked.click({ text: "Missing" })).rejects.toThrow(/not accepting it/);
    const allowed = make(heading());
    await allowed.click({ text: "Missing" });
    expect(allowed.heals).toHaveLength(1);
  });

  it("factsAreSnapshotted: a host changing its actions object while the model decides does not lift a restriction", async () => {
    const hostFacts: Record<string, string> = { click: "disallowed" };
    const driver = new RefDriver([link(), heading(hostFacts)]);
    const { llm } = scripted([{ action: "click", row: "heading" }, { action: "click", row: "link" }]);
    const mutating: LlmClient = { id: llm.id, async complete(prompt, opts) {
      const reply = await llm.complete(prompt, opts);
      hostFacts.click = "supported";
      return reply;
    } };
    await loops.discover(driver, mutating);
    expect(driver.acted).toEqual(["click:Alpha Curated goods from the Alpha store"]);
  });

  it("locatorRepairEmitsGate: locator repair records the same gate and keeps the row name out of the error", async () => {
    class Broken extends RefDriver {
      override async click(target: Target, ref?: string): Promise<void> {
        if (ref === undefined) throw Object.assign(new Error("element not found"), { kind: "resolution" });
        await super.click(target);
      }
    }
    const gates: unknown[] = [];
    const trace = startTrace({ emit: e => { if (e.kind === "gate") gates.push(e.payload); } }, "t").scope("eligibility");
    const healer = new SelfHealingDriver(new Broken([link(), heading({ click: "disallowed" })]),
      scripted([{ action: "click", row: "heading" }]).llm, { trace });
    const error = await healer.click({ text: "Missing" }).then(() => undefined, (e: unknown) => e as Error);
    expect(error?.message).toMatch(/not accepting it/);
    expect(error?.message).not.toContain("Alpha");
    expect(gates).toContainEqual({ gate: "action-eligibility", action: "click", reason: "measured-disallowed" });
  });
  it("rejectedDecisionNeverEnriches: a disallowed choice is refused before any locator work", async () => {
    class Counting extends RefDriver {
      located = 0;
      override async locateRef(ref: string): Promise<Target> { this.located++; return super.locateRef(ref); }
    }
    const driver = new Counting([link(), heading({ click: "disallowed" })]);
    await loops.discover(driver, scripted([{ action: "click", row: "heading" }, { action: "click", row: "link" }]).llm);
    expect(driver.located).toBe(1);
    expect(driver.acted).toEqual(["click:Alpha Curated goods from the Alpha store"]);
  });

  it("asyncEnrichmentKeepsEligibilityOfTheBoundRow: a snapshot published while the locator resolves neither blocks nor frees the decision", async () => {
    class Rotating extends RefDriver {
      override async locateRef(ref: string): Promise<Target> {
        const target = await super.locateRef(ref);
        await new Promise(resolve => setTimeout(resolve, 0));
        this.els = [heading({ click: "disallowed" }, { ref: "n-rotated" })];
        return target;
      }
    }
    const driver = new Rotating([heading(undefined, { ref: "n-first" })]);
    const gates: unknown[] = [];
    const trace = startTrace({ emit: e => { if (e.kind === "gate") gates.push(e.payload); } }, "t").scope("eligibility");
    const { llm, prompts } = scripted([{ action: "click", row: "heading" }, { action: "click", row: "heading" }]);
    await loops.discover(driver, llm, { trace });
    expect(driver.acted).toEqual(["click:Alpha"]);
    expect(prompts[2]).toContain("not run: the observed target is measured as not accepting \"click\"");
    expect(gates).toEqual([{ gate: "action-eligibility", action: "click", reason: "measured-disallowed" }]);
  });
});
