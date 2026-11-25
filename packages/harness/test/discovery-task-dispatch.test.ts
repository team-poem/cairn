import { describe, expect, it, vi } from "vitest";
import { discoverWithTasks, SelfHealingDriver, type DiscoveryTaskPlan, type LlmClient, type PageElement, type Target } from "../src/index.js";
import type { Driver } from "../src/core/ports.js";
import { StubDriver } from "./support/doubles.js";

const target = { role: "button", name: "Continue" };
const ready = { role: "checkbox", name: "Ready" };
const scope = { target, prerequisites: [ready] };
const named = { action: "click", text: target.name, role: target.role };
function model(withRef: boolean, change: () => void = () => {}): LlmClient {
  return { id: "task-dispatch", async complete(prompt) {
    if (prompt.includes("Propose the verification assertions.")) return "[]";
    const ref = prompt.split("\n").find(l => l.includes("[button] Continue"))?.match(/ref="([^"]+)"/)?.[1];
    if (withRef) expect(ref).toBeTruthy();
    change();
    return JSON.stringify(withRef ? { action: "click", ref } : named);
  } };
}
function plan(match: DiscoveryTaskPlan["match"] = () => "continue"): DiscoveryTaskPlan {
  return { tasks: [{ id: "continue", instruction: "Continue document A" }], onFailure: "stop", match,
    assess: vi.fn(() => ({route: "completed" as const, verification: "unknown" as const})) };
}
class References extends StubDriver {
  async locateRef(ref: string) {
    const row = this.els.find(e => e.ref === ref)!;
    return { text: row.name, role: row.role };
  }
}

describe("discovery task authorization at dispatch", () => {
  it("rejects a same-URL switch while enriching the unchanged button", async () => {
    const driver = new References();
    driver.els = [{...target, ref: "exact"}, {role: "heading", name: "Document A"}];
    const locate = driver.locateRef.bind(driver);
    driver.locateRef = async ref => {
      const result = await locate(ref);
      driver.els[1] = {role: "heading", name: "Document B"};
      return result;
    };
    const headings: string[] = [];
    const taskPlan = plan((_d, {elements}) => {
      const heading = elements.find(e => e.role === "heading")!.name;
      headings.push(heading);
      return heading === "Document A" ? "continue" : undefined;
    });
    const { progress } = await discoverWithTasks("Continue A", {driver, llm: model(true), taskPlan, maxSteps: 1});
    expect(headings).toEqual(["Document A", "Document B"]);
    expect(driver.clicked).toEqual([]);
    expect(taskPlan.assess).not.toHaveBeenCalled();
    expect(progress.remaining).toEqual(["continue"]);
  });

  it("does not transfer a ref to a same-named replacement", async () => {
    const driver = new References(), taskPlan = plan();
    driver.els = [{...target, ref: "first"}];
    const locate = driver.locateRef.bind(driver);
    driver.locateRef = async ref => {
      const result = await locate(ref);
      driver.els = [{...target, ref: "replacement"}];
      return result;
    };
    await discoverWithTasks("Continue A", {driver, llm: model(true), taskPlan, maxSteps: 1});
    expect(driver.clicked).toEqual([]);
    expect(taskPlan.assess).not.toHaveBeenCalled();
  });

  it.each(["stable", "replaced", "disallowed"] as const)("a named row beside an unrelated ref: %s", async state => {
    const driver = new References(), taskPlan = plan();
    driver.els = [{...target}, {role: "button", name: "Help", ref: "help"}];
    const llm = model(false, () => {
      if (state === "replaced") driver.els[0] = {...target, name: "Continue archived"};
      if (state === "disallowed") driver.els[0] = {...target, actions: {click: "disallowed"}};
    });
    await discoverWithTasks("Continue A", {driver, llm, taskPlan, maxSteps: 1});
    expect(driver.clicked).toEqual(state === "stable" ? ["Continue"] : []);
    expect(taskPlan.assess).toHaveBeenCalledTimes(state === "stable" ? 1 : 0);
  });

  it("does not fall back to fuzzy lookup when the adapter requires exact task input", async () => {
    const driver = Object.assign(new References(), { snapshotForTask: async (): Promise<PageElement[]> => [{...target}] });
    driver.els = [{...target}];
    const locate = vi.spyOn(driver, "locate");
    await discoverWithTasks("Continue A", {driver, llm: model(false), taskPlan: plan(), maxSteps: 1});
    expect(locate).not.toHaveBeenCalled();
    expect(driver.clicked).toEqual([]);
  });

  it("does not broaden a legacy named task through locator enrichment or store those fallbacks for replay", async () => {
    const driver = new StubDriver();
    driver.els = [{...target}];
    const locate = vi.spyOn(driver, "locate").mockResolvedValue({text:"Continue archived", selector: "#archived", index: 3});
    const {scenario} = await discoverWithTasks("Continue A", {driver, llm: model(false), taskPlan: plan(), maxSteps: 1});
    expect(driver.clicked).toEqual(["Continue"]);
    expect(scenario.steps.find(s => s.kind === "click")).toEqual(expect.objectContaining({target: {role:"button", text:"Continue"}}));
    expect(locate).not.toHaveBeenCalled();
  });

  it("does not let a self-healing driver retry a failed legacy task with another target", async () => {
    const inner = new StubDriver();
    inner.els = [{...target}, {role: "button", name: "Archived"}];
    const click = vi.spyOn(inner, "click").mockRejectedValue(new Error("input unconfirmed"));
    const healer = {id: "repair", complete: vi.fn(async () => '{"name":"Archived"}')};
    const taskPlan = plan();
    const result = await discoverWithTasks("Continue A", {driver: new SelfHealingDriver(inner, healer), llm: model(false), taskPlan, maxSteps: 1});
    expect(click).toHaveBeenCalledTimes(1);
    expect(healer.complete).not.toHaveBeenCalled();
    expect(taskPlan.assess).not.toHaveBeenCalled();
    expect(result.progress.reason).toBe("dispatch-uncertain");
  });

  it.each(["read-after-approval", "changed-document", "foreign-origin", "borrowed-origin"] as const)(
    "keeps both task and secret approval valid at type dispatch: %s", async mode => {
      const trusted = "https://form.test/", foreign = "https://other.test/";
      const driver = new StubDriver(mode === "borrowed-origin" ? foreign : trusted);
      driver.els = [{role: "textbox", name: "Code"}, {role: "heading", name: "A"}];
      const sent: string[] = [];
      driver.type = async () => { sent.push(driver.els[1]!.name); };
      let deciding = false, approvals = 0, reads = 0;
      const observe = driver.observe.bind(driver);
      driver.observe = async () => {
        const evidence = await observe();
        if (!deciding || sent.length) return evidence;
        // A read left between the last task approval and driver.type could switch
        // records without navigating. On the fixed path no such read is needed.
        if (mode === "read-after-approval" && approvals === 2) driver.els[1]!.name = "B";
        if (++reads === 2) { // secret origin read, just after the pre-vet evidence
          if (mode === "changed-document") driver.els[1]!.name = "B";
          if (mode === "foreign-origin") evidence.execution.finalUrl = foreign;
          if (mode === "borrowed-origin") evidence.execution.finalUrl = trusted;
        }
        return evidence;
      };
      const taskPlan = plan((_d, ctx) => { approvals++; return ctx.elements.some(e => e.name === "A") ? "continue" : undefined; });
      await discoverWithTasks("Fill only A", {driver, maxSteps: 1, taskPlan,
        secrets: {code: {value: "fixture-secret", origin: "https://form.test"}}, llm: {id: "form", async complete(prompt) {
          if (prompt.includes("Propose the verification assertions.")) return "[]";
          deciding = true;
          return JSON.stringify({action: "type", text: "Code", role: "textbox", value: "{code}"});
        }}});
      expect(sent).toEqual(mode === "read-after-approval" ? ["A"] : []);
      expect(taskPlan.assess).toHaveBeenCalledTimes(sent.length);
    });

  it.each([true, false])("a scoped task uses the receipt for both named and ref clicks (ref: %s)", async withRef => {
    for (const state of ["stable", "prerequisite", "replaced", "disallowed"] as const) {
      class Scoped extends References {
        checked = true;
        node = "button-1";
        sent: (string | undefined)[] = [];
        snapshotWithGuidanceScope: NonNullable<Driver["snapshotWithGuidanceScope"]> = async () => ({
          elements: [...this.els, {...ready, checked: this.checked}],
          facts: {complete: true, documentId: "doc", targets: [{...target, id: this.node, disabled: false, occluded: false}],
            prerequisites: [{members: [{...ready, id: "ready", checked: this.checked, value: "on", indeterminate: false, disabled: false}]}]},
          targetRef: "scope-receipt",
        });
        override async click(_t: Target, ref?: string, before?: () => void) { before?.(); this.sent.push(ref); }
      }
      const driver = new Scoped(), taskPlan = plan();
      driver.els = [{...target, ref: "observed-node"}];
      const llm = model(withRef, () => {
        if (state === "prerequisite") driver.checked = false;
        if (state === "replaced") driver.node = "button-2";
        if (state === "disallowed") driver.els = [{...target, ref: "observed-node", actions: {click: "disallowed"}}];
      });
      await discoverWithTasks("Continue A", {driver, llm, taskPlan, maxSteps: 1, pageGuidanceScope: scope,
        pageGuidance: () => ({text: "Continue while ready", freshness: "declared-scope"})});
      expect(driver.sent, state).toEqual(state === "stable" ? ["scope-receipt"] : []);
      expect(taskPlan.assess, state).toHaveBeenCalledTimes(state === "stable" ? 1 : 0);
    }
  });
});
