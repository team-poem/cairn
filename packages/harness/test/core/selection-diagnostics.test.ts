import { expect, it, vi } from "vitest";
import { PerceptionObservation } from "../../src/core/observation.js";
import { selectElements } from "../../src/core/perception.js";
import { candidateCounts } from "../../src/core/selection-diagnostics.js";
import { startTrace, type TraceEvent } from "../../src/core/trace.js";
import { discover } from "../../src/core/discover/index.js";
import { explore } from "../../src/core/explore/index.js";
import { BudgetExceededError } from "../../src/core/budget.js";
import { stepError } from "../../src/core/errors.js";
import { LlmStepHealer } from "../../src/core/step-heal.js";
import { SelfHealingDriver } from "../../src/adapters/drivers/self-heal.js";
import { runScenario } from "../../src/run.js";
import type { PageElement, Scenario, Target } from "../../src/core/types.js";
import type { LlmClient, PerceptionAdapter } from "../../src/core/ports.js";
import { StubDriver } from "../support/doubles.js";

function trace(throws = false) {
  const events: TraceEvent[] = [];
  const scope = startTrace({ emit(event) {
    events.push(event);
    if (throws) throw new Error("sink unavailable");
  } }, "test").scope("selection-case");
  return { events, scope };
}
function selections(events: TraceEvent[]) {
  return events.filter((event): event is Extract<TraceEvent, { kind: "selection" }> => event.kind === "selection");
}
function summary(raw: PageElement[], perceived = raw, limit = 60, intent = "save") {
  const { events, scope } = trace();
  const page = new PerceptionObservation(new StubDriver(), raw, perceived, intent, limit, true);
  page.tracePrepared(scope, "discover", "discover");
  return { page, diagnostic: selections(events)[0]!.payload };
}

it("reports the actual final selection after evidence swaps, not the initial ranked cut", () => {
  const rows: PageElement[] = [
    ...Array.from({ length: 61 }, (_, i) => ({ name: `button ${i}`, role: "button" })),
    { name: "save complete", role: "StaticText" },
  ];
  const { page, diagnostic } = summary(rows);
  expect(diagnostic).toMatchObject({
    raw: { count: 62 }, perceived: { count: 62 }, eligible: { count: 62 },
    selected: { count: 60, roles: { button: 59, text: 1 } }, capOmitted: 2,
    excluded: { occluded: 0, clickableRegionOrQuota: 0 },
  });
  expect(page.render).toContain("save complete");
  expect(page.render).not.toContain("button 59");
  const without = selectElements(rows, "save", 60);
  const withDiagnostics = selectElements(rows, "save", 60, true);
  expect(withDiagnostics.elements).toEqual(without.elements);
  expect(withDiagnostics.diagnostics?.selected).toEqual(candidateCounts(without.elements));
  expect(without.diagnostics).toBeUndefined();
});

it("accounts for positive occlusion and clickable exclusions without excluding retained evidence", () => {
  const rows: PageElement[] = [
    { name: "covered", role: "button", occluded: true },
    { name: "region representative", role: "StaticText", clickable: true, clickableRegion: "private-region" },
    { name: "redundant", role: "StaticText", clickable: true, clickableRegion: "private-region" },
    { name: "save evidence", role: "StaticText", clickable: true, clickableRegion: "private-region" },
    ...Array.from({ length: 40 }, (_, i) => ({ name: `region ${i}`, role: "StaticText", clickable: true })),
    { name: "save over quota", role: "StaticText", clickable: true },
  ];
  const { page, diagnostic: d } = summary(rows);
  expect(d.excluded).toEqual({ occluded: 1, clickableRegionOrQuota: 2 });
  expect(d.eligible.count).toBe(42);
  expect(d.perceived.count).toBe(d.excluded.occluded + d.excluded.clickableRegionOrQuota + d.eligible.count);
  expect(d.eligible.count).toBe(d.selected.count + d.capOmitted);
  expect(page.render).toContain("save evidence");
  expect(page.render).toContain("save over quota");
});

it.each([
  { name: "empty", rows: [], cap: 60, eligible: 0, selected: 0, occluded: 0 },
  { name: "all filtered", rows: [{ name: "x", role: "button", occluded: true }], cap: 60, eligible: 0, selected: 0, occluded: 1 },
  { name: "zero cap", rows: [{ name: "x", role: "button" }], cap: 0, eligible: 1, selected: 0, occluded: 0 },
  { name: "legacy duplicates", rows: [{ name: "Save", role: "button" }, { name: "Save", role: "button" }], cap: 60, eligible: 2, selected: 2, occluded: 0 },
])("keeps count partitions honest for $name", ({ rows, cap, eligible, selected, occluded }) => {
  const { diagnostic: d } = summary(rows, rows, cap);
  expect(d.eligible.count).toBe(eligible);
  expect(d.selected.count).toBe(selected);
  expect(d.capOmitted).toBe(eligible - selected);
  expect(d.excluded.occluded).toBe(occluded);
  for (const stage of [d.raw, d.perceived, d.eligible, d.selected]) {
    expect(Object.values(stage.roles).reduce((a, b) => a + b, 0)).toBe(stage.count);
  }
});

it("keeps host transformations separate, including additions and equal-count role changes", () => {
  const raw = [{ name: "private raw", role: "button" }];
  const perceived = [{ name: "private replacement", role: "textbox" }, { name: "added", role: "link" }];
  const { diagnostic: d } = summary(raw, perceived);
  expect(d.raw).toMatchObject({ count: 1, roles: { button: 1 } });
  expect(d.perceived).toMatchObject({ count: 2, roles: { input: 1, link: 1 } });
  expect(d.excluded).toEqual({ occluded: 0, clickableRegionOrQuota: 0 });
  const sameCount = summary(raw, perceived.slice(0, 1)).diagnostic;
  expect(sameCount.raw.count).toBe(sameCount.perceived.count);
  expect(sameCount.raw.roles).not.toEqual(sameCount.perceived.roles);
});

it("never serializes page content, unknown role strings, refs, region IDs or content hashes", () => {
  const markers = ["PRIVATE_NAME", "PRIVATE_VALUE", "PRIVATE_ROLE", "PRIVATE_REF", "PRIVATE_REGION", "https://private.example/path", "<b>private html</b>"];
  const rows = markers.map((name, i) => ({ name, role: markers[2]!, value: markers[1]!, ref: `${markers[3]}-${i}`, clickableRegion: markers[4] }));
  const { diagnostic: d } = summary(rows);
  expect(d.raw.roles.other).toBe(markers.length);
  const serialized = JSON.stringify(d);
  for (const marker of markers) expect(serialized).not.toContain(marker);
  expect(Object.keys(d).sort()).toEqual(["capOmitted", "decisionId", "eligible", "excluded", "observationId", "perceived", "purpose", "raw", "selected", "stage"].sort());
  expect(d.observationId).toMatch(/^o\d+$/);
  expect(d.decisionId).toBe(`${d.observationId}:d1`);
  expect(candidateCounts([{ name: "x", role: "__proto__" }]).roles.other).toBe(1);
});

for (const mode of ["discover", "explore"] as const) {
  const run = mode === "discover" ? discover : explore;
  it(`${mode}: correlates repeated decisions without treating them as frozen steps`, async () => {
    const driver = new StubDriver();
    driver.els = [{ name: "Private Save", role: "button" }, { name: "Private Delete", role: "button" }];
    const { events, scope } = trace();
    let decisions = 0;
    const llm: LlmClient = { id: "test", async complete(prompt) {
      if (!prompt.includes("What is the single next action?")) return "[]";
      decisions++;
      expect(selections(events)).toHaveLength(decisions);
      expect(prompt).toContain("Private Save");
      expect(prompt).not.toContain("Private Delete");
      return decisions === 1 ? "not json" : '{"action":"done"}';
    } };
    const capture = vi.spyOn(driver, "snapshot");
    await run("save", { driver, llm, trace: scope, baseUrl: "https://app/start", maxSteps: 2, perceive: rows => rows.slice(0, 1) });
    const selected = selections(events);
    expect(selected).toHaveLength(2);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(new Set(selected.map(e => e.payload.decisionId)).size).toBe(2);
    for (const e of selected) {
      expect(e.stepRef).toBeUndefined();
      expect(e).toMatchObject({ phase: mode, caseRef: "selection-case", payload: {
        stage: "prepared", purpose: mode, raw: { count: 2 }, perceived: { count: 1 }, selected: { count: 1 },
      } });
      expect(JSON.stringify(e.payload)).not.toContain("Private");
    }
  });

  it(`${mode}: policy stop has no prepared decision input`, async () => {
    const { events, scope } = trace();
    const llm: LlmClient = { id: "test", complete: vi.fn(async () => "[]") };
    await run("save", { driver: new StubDriver(), llm, trace: scope, baseUrl: "https://app/start", maxSteps: 1,
      policy: { stop: () => true, vet: () => ({ ok: true }) } });
    expect(selections(events)).toEqual([]);
  });

  it(`${mode}: exhausted admission is prepared input, never evidence of a dispatched model call`, async () => {
    const { events, scope } = trace();
    const llm: LlmClient = { id: "test", complete: vi.fn(async () => '{"action":"done"}') };
    await expect(run("save", { driver: new StubDriver(), llm, trace: scope, baseUrl: "https://app/start", maxSteps: 1,
      budget: { maxModelCalls: 0 } })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(llm.complete).not.toHaveBeenCalled();
    expect(selections(events)).toHaveLength(1);
    expect(selections(events)[0]!.payload.stage).toBe("prepared");
    expect(events.some(e => e.kind === "budget-exhausted")).toBe(true);
  });

  it(`${mode}: rejected observation emits a binding gate, not prepared input`, async () => {
    const driver = new StubDriver();
    driver.els = [{ name: "Private Save", role: "button", ref: "private-driver-token" }];
    const { events, scope } = trace();
    const llm: LlmClient = { id: "test", complete: vi.fn(async () => "[]") };
    await run("save", { driver, llm, trace: scope, baseUrl: "https://app/start", maxSteps: 1,
      perceive: rows => rows.map(row => ({ ...row, role: "link" })) });
    expect(selections(events)).toEqual([]);
    expect(events.some(e => e.kind === "gate" && e.payload.gate === "perception-binding")).toBe(true);
    const decisionCalls = vi.mocked(llm.complete).mock.calls.filter(([prompt]) => prompt.includes("What is the single next action?"));
    expect(decisionCalls).toEqual([]);
  });

  it(`${mode}: budget-wrapped cancellation during perceive never admits the prepared input`, async () => {
    const driver = new StubDriver();
    driver.els = [{ name: "Save", role: "button" }];
    const controller = new AbortController();
    const reason = new Error("host cancelled during perception");
    const { events, scope } = trace();
    const llm: LlmClient = { id: "test", complete: vi.fn(async () => '{"action":"click","text":"Save"}') };
    const perceive = vi.fn(async (rows: PageElement[]) => {
      await Promise.resolve();
      controller.abort(reason);
      return rows;
    });
    await expect(run("save", { driver, llm, trace: scope, baseUrl: "https://app/start", maxSteps: 2,
      budget: {}, signal: controller.signal, perceive })).rejects.toBe(reason);
    expect(perceive).toHaveBeenCalledTimes(1);
    expect(llm.complete).not.toHaveBeenCalled();
    expect(driver.clicked).toEqual([]);
    expect(selections(events)).toHaveLength(1);
    expect(selections(events)[0]).toMatchObject({ phase: mode, payload: { stage: "prepared", purpose: mode } });
    expect(events.filter(e => e.kind === "action" || e.kind === "budget-exhausted")).toEqual([]);
  });

  it(`${mode}: model failure leaves only a prepared summary, not a successful action`, async () => {
    const { events, scope } = trace();
    const llm: LlmClient = { id: "test", complete: vi.fn(async () => { throw new Error("model unavailable"); }) };
    await expect(run("save", { driver: new StubDriver(), llm, trace: scope,
      baseUrl: "https://app/start", maxSteps: 1 })).rejects.toThrow("model unavailable");
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(selections(events)).toHaveLength(1);
    expect(selections(events)[0]!.payload.stage).toBe("prepared");
    expect(events.filter(e => e.kind === "action")).toEqual([]);
  });

  it(`${mode}: disabled and throwing traces preserve actions, calls and results`, async () => {
    const outputs = [];
    for (const tracing of ["off", "on", "throws"] as const) {
      const driver = new StubDriver();
      driver.els = [{ name: "Save", role: "button" }];
      const { events, scope } = trace(tracing === "throws");
      let decisions = 0;
      const llm: LlmClient = { id: "test", complete: vi.fn(async prompt => {
        if (!prompt.includes("What is the single next action?")) return "[]";
        return ++decisions === 1 ? '{"action":"click","text":"Save"}' : '{"action":"done"}';
      }) };
      const capture = vi.spyOn(driver, "snapshot");
      const observe = vi.spyOn(driver, "observe");
      const result = await run("save", { driver, llm, baseUrl: "https://app/start", maxSteps: 2, ...(tracing === "off" ? {} : { trace: scope }) });
      outputs.push({ result, clicks: driver.clicked, modelCalls: vi.mocked(llm.complete).mock.calls.length,
        captures: capture.mock.calls.length, observes: observe.mock.calls.length });
      if (tracing !== "off") expect(selections(events)).toHaveLength(2);
    }
    expect(outputs[1]).toEqual(outputs[0]);
    expect(outputs[2]).toEqual(outputs[0]);
  });
}

it("explore final outcome capture is not a decision input", async () => {
  const driver = new StubDriver();
  driver.els = [{ name: "Save", role: "button" }];
  const capture = vi.spyOn(driver, "snapshot");
  const { events, scope } = trace();
  await explore("save", { driver, trace: scope, baseUrl: "https://app/start", maxSteps: 1,
    llm: { id: "test", async complete() { return '{"action":"click","text":"Save"}'; } } });
  expect(capture).toHaveBeenCalledTimes(2);
  expect(selections(events)).toHaveLength(1);
});

it("outcome rediscovery retains heal phase without labeling assertion proposals as selection", async () => {
  const { events, scope } = trace();
  await discover("save", { driver: new StubDriver(), trace: scope, tracePhase: "heal", maxSteps: 1,
    llm: { id: "test", async complete(prompt) { return prompt.includes("What is the single next action?") ? '{"action":"done"}' : "[]"; } } });
  expect(selections(events)).toHaveLength(1);
  expect(selections(events)[0]).toMatchObject({ phase: "heal", payload: { purpose: "discover" } });
});

class RepairDriver extends StubDriver {
  override async click(target: Target): Promise<void> {
    if (target.text === "Old Save") throw stepError("resolution", "element not found");
    await super.click(target);
  }
}

it.each(["locator", "step"] as const)("%s repair with zero model budget records preparation but performs no repair", async kind => {
  const driver = new RepairDriver();
  driver.els = [{ name: "Save", role: "button" }];
  driver.navOn.Save = "https://app/done";
  const click = vi.spyOn(driver, "click");
  const capture = vi.spyOn(driver, "snapshot");
  const events: TraceEvent[] = [];
  const scenario: Scenario = { name: "budgeted repair", steps: [
    { kind: "goto", url: "https://app/start" },
    { kind: "click", target: { text: kind === "locator" ? "Old Save" : "Wrong" },
      intent: "save", expect: { url: "https://app/done" } },
  ], assertions: [{ kind: "navigated", to: "https://app/done" }] };
  const llm: LlmClient = { id: "test", complete: vi.fn(async () => kind === "locator"
    ? '{"name":"Save"}' : '{"action":"click","text":"Save"}') };
  const result = await runScenario(scenario, { driver, llm, heal: true, expectTimeoutMs: 0,
    budget: { maxModelCalls: 0 }, trace: { emit: event => { events.push(event); } },
    reporter: { async emit() {} } });
  expect(result.result.verdict).toMatchObject({ passed: false, failure: "budget",
    budget: { limit: "model-calls", modelCalls: 0 } });
  expect(llm.complete).not.toHaveBeenCalled();
  expect(click).toHaveBeenCalledTimes(1); // The original replay attempt, never a repair dispatch.
  expect(driver.clicked).not.toContain("Save");
  expect(capture).toHaveBeenCalledTimes(1);
  expect(result.heals).toEqual([]);
  expect(result.stepHeals).toEqual([]);
  expect(result.healedScenario).toBeUndefined();
  expect(selections(events)).toHaveLength(1);
  expect(selections(events)[0]).toMatchObject({ phase: "heal", caseRef: scenario.name,
    payload: { stage: "prepared", purpose: `${kind}-heal` } });
  expect(events.filter(e => e.kind === "budget-exhausted")).toHaveLength(1);
  expect(events.filter(e => e.kind === "heal")).toEqual([]);
  expect(events.findIndex(e => e.kind === "selection")).toBeLessThan(events.findIndex(e => e.kind === "budget-exhausted"));
});

it("both standalone healers trace actual prompt selection, with raw and perceived counts", async () => {
  for (const kind of ["locator", "step"] as const) {
    const driver = new RepairDriver();
    driver.els = [{ name: "Save", role: "button" }, { name: "Drop", role: "button" }];
    const { events, scope } = trace();
    const perceive: PerceptionAdapter = rows => rows.slice(0, 1);
    const llm: LlmClient = { id: "test", async complete(prompt) {
      expect(prompt).not.toContain("Drop");
      expect(selections(events)).toHaveLength(1);
      return kind === "locator" ? '{"name":"Save"}' : '{"action":"click","text":"Save"}';
    } };
    if (kind === "locator") await new SelfHealingDriver(driver, llm, { trace: scope, perceive }).click({ text: "Old Save" });
    else await new LlmStepHealer(llm, 5, {}, { trace: scope, perceive }).heal({ kind: "click", target: { text: "Save" } }, 42, driver);
    expect(selections(events)[0]).toMatchObject({ phase: "heal", payload: {
      purpose: `${kind}-heal`, raw: { count: 2 }, perceived: { count: 1 }, selected: { count: 1 },
    } });
    expect(selections(events)[0]!.stepRef).toBeUndefined();
    expect(driver.clicked).toEqual(["Save"]);
  }
});

it("healer attempt limits and finite-choice pilot do not fabricate prepared ordinary input", async () => {
  const driver = new RepairDriver();
  driver.els = [{ name: "Save", role: "button" }];
  const { events, scope } = trace();
  const llm: LlmClient = { id: "test", complete: vi.fn(async () => '{"name":"Save"}') };
  await expect(new SelfHealingDriver(driver, llm, { trace: scope, maxHeals: 0 }).click({ text: "Old Save" })).rejects.toThrow();
  expect(await new LlmStepHealer(llm, 0, {}, { trace: scope }).heal({ kind: "click", target: {} }, 0, driver)).toBeNull();
  const choose = vi.fn(async () => { throw new Error("no candidate"); });
  await expect(new SelfHealingDriver(driver, llm, { trace: scope,
    choice: { prepare: () => choose },
  }).click({ text: "Old Save" })).rejects.toThrow("no candidate");
  expect(choose).toHaveBeenCalledTimes(1);
  expect(selections(events)).toEqual([]);
  expect(llm.complete).not.toHaveBeenCalled();
});

it("runScenario wires locator and surgical repair traces; healthy replay emits neither", async () => {
  for (const kind of ["healthy", "locator", "step"] as const) {
    const driver = new RepairDriver();
    driver.els = [{ name: "Save", role: "button" }];
    driver.navOn.Save = "https://app/done";
    const events: TraceEvent[] = [];
    const scenario: Scenario = { name: "save", steps: [
      { kind: "goto", url: "https://app/start" },
      { kind: "click", target: { text: kind === "locator" ? "Old Save" : kind === "step" ? "Wrong" : "Save" },
        intent: "save", expect: { url: "https://app/done" } },
    ], assertions: [{ kind: "navigated", to: "https://app/done" }] };
    const llm: LlmClient = { id: "test", complete: vi.fn(async () => kind === "locator" ? '{"name":"Save"}' : '{"action":"click","text":"Save"}') };
    const result = await runScenario(scenario, { driver, llm, heal: true, expectTimeoutMs: 0,
      trace: { emit: e => { events.push(e); } }, reporter: { async emit() {} } });
    expect(result.result.verdict.passed).toBe(true);
    expect(selections(events)).toHaveLength(kind === "healthy" ? 0 : 1);
    if (kind === "healthy") expect(llm.complete).not.toHaveBeenCalled();
    else expect(selections(events)[0]).toMatchObject({ caseRef: "save", phase: "heal", payload: { purpose: `${kind}-heal` } });
  }
});
