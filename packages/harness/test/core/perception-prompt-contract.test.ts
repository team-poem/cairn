// file: packages/harness/test/core/perception-prompt-contract.test.ts
import { expect, it } from "vitest";
import { PerceptionObservation } from "../../src/core/observation.js";
import { applyDecision, parseDecision } from "../../src/core/discover/decision.js";
import { discover } from "../../src/core/discover/index.js";
import { SYSTEM, ACTION_VOCABULARY, ACTION_RULES, PERCEPTION_RULES } from "../../src/core/discover/prompt.js";
import { LlmStepHealer } from "../../src/core/step-heal.js";
import { explore } from "../../src/core/explore/index.js";
import { EXPLORE_SYSTEM } from "../../src/core/explore/prompt.js";
import type { Driver, LlmClient, PerceptionAdapter } from "../../src/core/ports.js";
import type { PageElement, Target } from "../../src/core/types.js";
import { startTrace } from "../../src/core/trace.js";
import { StubDriver } from "../support/doubles.js";

class PromptRefDriver extends StubDriver {
  readonly exact: string[] = [];
  constructor(rows: PageElement[] = [{ role: "button", name: "Save", ref: "node-save" }]) {
    super();
    this.els = rows;
  }
  async locateRef(ref: string): Promise<Target> {
    const row = this.els.find(e => e.ref === ref);
    if (!row) throw new Error("unknown driver ref");
    return { text: row.name, role: row.role, selector: `#${ref}` };
  }
  override async click(_target: Target, ref?: string): Promise<void> {
    if (!ref) throw new Error("unexpected legacy fallback");
    this.exact.push(ref);
  }
}
function promptRef(text: string): string {
  const ref = text.match(/ref="([^"]+)"/)?.[1];
  if (!ref) throw new Error("missing observation ref in prompt");
  return ref;
}
class PromptRecordingLlm implements LlmClient {
  readonly id = "phase2-scripted";
  readonly prompts: string[] = [];
  readonly systems: string[] = [];
  constructor(private readonly reply: (prompt: string, turn: number) => string = () => '{"action":"done"}') {}
  async complete(prompt: string, opts?: Parameters<LlmClient["complete"]>[1]): Promise<string> {
    if (!prompt.includes("What is the single next action?")) return "[]";
    this.prompts.push(prompt);
    this.systems.push(opts?.system ?? "");
    return this.reply(prompt, this.prompts.length);
  }
}
async function runPromptLoop(mode: "discover" | "explore", driver: Driver, llm: LlmClient, perceive?: PerceptionAdapter) {
  const opts = { driver, llm, perceive, baseUrl: "https://app/start", maxSteps: 4 };
  return mode === "discover" ? discover("save", opts) : explore("save", opts);
}

it("normalizedPerceivePreservesCanonicalRef: trimming a label preserves exact driver identity and raw persistent description", async () => {
  for (const mode of ["discover", "explore"] as const) {
    const driver = new PromptRefDriver([{ role: "button", name: "  Save  ", ref: "node-save" }]);
    const llm = new PromptRecordingLlm((prompt, turn) => turn === 1
      ? JSON.stringify({ action: "click", ref: promptRef(prompt), text: "save" })
      : '{"action":"done"}');
    const result = await runPromptLoop(mode, driver, llm, rows => rows.map(row => ({ ...row, name: row.name.trim() })));
    expect(result.truncated).not.toBe(true);
    expect(driver.exact).toEqual(["node-save"]);
    expect(result.steps.find(step => step.kind === "click")).toMatchObject({ target: { text: "  Save  ", role: "button", selector: "#node-save" } });
    expect(driver.els[0]?.name).toBe("  Save  ");
  }
});

it("shortenedRefDescriptionsReachTheSelectedNode: both loops accept a substring and freeze the full description", async () => {
  const name = "Wireless Earbuds Pro 2 $129.00 free shipping 4.8 (1,204)";
  for (const mode of ["discover", "explore"] as const) {
    const driver = new PromptRefDriver([{ role: "button", name, ref: "node-product" }]);
    const llm = new PromptRecordingLlm((prompt, turn) => turn === 1
      ? JSON.stringify({ action: "click", ref: promptRef(prompt), text: "Wireless Earbuds Pro 2" })
      : '{"action":"done"}');
    const result = await runPromptLoop(mode, driver, llm);
    expect(result.truncated).not.toBe(true);
    expect(driver.exact).toEqual(["node-product"]);
    expect(result.steps.find(step => step.kind === "click")).toEqual({
      kind: "click", target: { text: name, role: "button", selector: "#node-product" },
    });
    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[1]).not.toContain("reference binding rejected");
  }
});

it("invalidPerceiveEndsBoundedly: both loops recover a fresh valid capture after a rejected binding and bound persistent failures", async () => {
  for (const mode of ["discover", "explore"] as const) {
    for (const change of [{ name: "Delete" }, { role: "link" }]) {
      const driver = new PromptRefDriver();
      let perceptionCalls = 0;
      const callsAtDecision: number[] = [];
      const llm = new PromptRecordingLlm((prompt, turn) => {
        callsAtDecision.push(perceptionCalls);
        return turn === 1 ? JSON.stringify({ action: "click", ref: promptRef(prompt) }) : '{"action":"done"}';
      });
      const result = await runPromptLoop(mode, driver, llm, rows => {
        perceptionCalls++;
        return perceptionCalls === 1 ? rows.map(row => ({ ...row, ...change })) : rows;
      });
      expect(result.truncated).not.toBe(true);
      expect(driver.exact).toEqual(["node-save"]);
      expect(result.steps.filter(step => step.kind === "click")).toEqual([
        { kind: "click", target: { text: "Save", role: "button", selector: "#node-save" } },
      ]);
      expect(callsAtDecision[0]).toBe(2);
      expect(llm.prompts[0]).toMatch(/perception|binding/i);
      expect(llm.prompts[0]).not.toContain("not a single valid JSON action object");

      const invalidDriver = new PromptRefDriver();
      const neverCalled = new PromptRecordingLlm();
      let invalidCaptures = 0;
      const incomplete = await runPromptLoop(mode, invalidDriver, neverCalled, rows => {
        invalidCaptures++;
        return rows.map(row => ({ ...row, ...change }));
      });
      expect(incomplete.truncated).toBe(true);
      expect(incomplete.steps.filter(step => step.kind !== "goto")).toEqual([]);
      expect(invalidDriver.exact).toEqual([]);
      expect(neverCalled.prompts).toEqual([]);
      expect(invalidCaptures).toBeGreaterThan(1);
      expect(invalidCaptures).toBeLessThanOrEqual(4);
    }
  }
});

it("normalizedRefDescriptionsUseRawIdentity: model label normalization binds the same ref and preserves real contradictions", async () => {
  const driver = new PromptRefDriver([{ role: "button", name: "  Save  ", ref: "node-save" }]);
  const page = new PerceptionObservation(driver, driver.els, driver.els, "save");
  const decision = page.bind({ action: "click", ref: promptRef(page.references), text: "save", role: "button" });
  expect(decision).toMatchObject({ text: "  Save  ", role: "button" });
  await applyDecision(driver, decision);
  expect(driver.exact).toEqual(["node-save"]);
  for (const contradiction of [{ text: "Delete" }, { role: "link" }, { nth: 1 }]) {
    const next = new PerceptionObservation(driver, driver.els, driver.els, "save");
    expect(() => next.bind({ action: "click", ref: promptRef(next.references), ...contradiction })).toThrow(/contradict/i);
  }
  expect(driver.exact).toEqual(["node-save"]);
});

it("referenceFailureIsNotMalformedJson: both loops teach a fresh reference after valid JSON with an unknown ref", async () => {
  for (const mode of ["discover", "explore"] as const) {
    const driver = new PromptRefDriver();
    const llm = new PromptRecordingLlm((_prompt, turn) => turn === 1
      ? '{"action":"click","ref":"forged"}'
      : turn === 2 ? 'this is not JSON' : '{"action":"done"}');
    await runPromptLoop(mode, driver, llm);
    expect(llm.prompts[1]).toMatch(/unknown|expired/i);
    expect(llm.prompts[1]).toMatch(/reference|ref/i);
    expect(llm.prompts[1]).not.toContain("not a single valid JSON action object");
    expect(llm.prompts[2]).toContain("not a single valid JSON action object");
    expect(driver.exact).toEqual([]);
  }
});

it("systemTeachesExecutableRefActions: every target action has a ref-only example usable without text role or nth", () => {
  const examples = [...ACTION_VOCABULARY.matchAll(/\{[^{}]*"ref"[^{}]*\}/g)].map(match => parseDecision(match[0]));
  for (const action of ["click", "doubleClick", "hover", "type", "select"] as const) {
    const example = examples.find(decision => decision.action === action && decision.text === undefined && decision.role === undefined && decision.nth === undefined);
    expect(example, `missing ref-only ${action} example`).toBeDefined();
    const driver = new PromptRefDriver([
      { role: "button", name: "Save", ref: "first" },
      { role: "button", name: "Save", ref: "second" },
    ]);
    const page = new PerceptionObservation(driver, driver.els, driver.els, "save");
    const second = page.references.split("\n").find(line => line.includes("nth=1"))!;
    expect(page.bind({ ...example!, ref: promptRef(second) })).toMatchObject({ action, text: "Save", role: "button", nth: 1 });
  }
  for (const system of [SYSTEM, EXPLORE_SYSTEM]) {
    expect(system).toContain(ACTION_VOCABULARY);
    expect(system).toMatch(/ref[\s\S]{0,160}(?:current|this) (?:observation|decision)/i);
    expect(system).toMatch(/(?:without|omit|optional)[\s\S]{0,100}(?:text|role|nth)/i);
  }
});

it("systemExplainsMeasuredInteractionFacts: shared rules explain clickable and active popup without promising effects or inventing roles", () => {
  expect(PERCEPTION_RULES).toMatch(/clickable/i);
  expect(PERCEPTION_RULES).toMatch(/active popup/i);
  expect(PERCEPTION_RULES).toMatch(/(?:does not|not|no)[\s\S]{0,60}(?:guarantee|prove)[\s\S]{0,70}(?:effect|success|result)/i);
  expect(PERCEPTION_RULES).toMatch(/(?:role[\s\S]{0,100}(?:unchanged|retain|preserv))|(?:(?:retain|preserv)[\s\S]{0,100}role)/i);
  const driver = new PromptRefDriver([{ role: "StaticText", name: "Open", ref: "node-open", clickable: true, inActivePopup: true }]);
  const page = new PerceptionObservation(driver, driver.els, driver.els, "open");
  expect(page.references).toContain("[StaticText] Open (clickable, active popup)");
  for (const system of [SYSTEM, EXPLORE_SYSTEM]) expect(system).toContain(PERCEPTION_RULES);
});

it("referenceTableDeclaresTruncation: the ref table reports candidates omitted by the same hard row budget", () => {
  const driver = new PromptRefDriver(Array.from({ length: 61 }, (_, i) => ({ role: "button", name: `Choice ${i}`, ref: `node-${i}` })));
  const page = new PerceptionObservation(driver, driver.els, driver.els, "choose", 60);
  expect(page.references.match(/^- ref=/gm)).toHaveLength(60);
  expect(page.references).toMatch(/1 more elements? not shown/);
  expect(page.references).toMatch(/scroll|interact/i);
  const uncut = new PerceptionObservation(driver, driver.els, driver.els, "choose", 61);
  expect(uncut.references).not.toMatch(/more elements? not shown/);
});

it("pageDataPrecedesFinalActionInstruction: both loop requests end with the instruction after current reference data on every turn", async () => {
  for (const mode of ["discover", "explore"] as const) {
    const marker = "PAGE_DATA_LAST_ROW_221";
    const driver = new PromptRefDriver([{ role: "button", name: marker, ref: "node-save" }]);
    const llm = new PromptRecordingLlm((_prompt, turn) => turn === 1 ? '{"action":"pressKey","key":"Escape"}' : '{"action":"done"}');
    await runPromptLoop(mode, driver, llm);
    expect(llm.prompts).toHaveLength(2);
    for (const prompt of llm.prompts) {
      expect(prompt.trimEnd().endsWith("What is the single next action? Respond with JSON only.")).toBe(true);
      expect(prompt.lastIndexOf(marker)).toBeLessThan(prompt.lastIndexOf("What is the single next action?"));
      expect(promptRef(prompt)).toBeTruthy();
    }
    expect(promptRef(llm.prompts[0]!)).not.toBe(promptRef(llm.prompts[1]!));
  }
});

it("stepHealTeachesAndExecutesRefOnlySchema: the healer receives shared target rules and dispatches the chosen duplicate from a ref-only example", async () => {
  const driver = new PromptRefDriver([
    { role: "button", name: "Save", ref: "first" },
    { role: "button", name: "Save", ref: "second" },
  ]);
  const prompts: string[] = [];
  const systems: string[] = [];
  const llm: LlmClient = {
    id: "phase2-heal-schema",
    async complete(prompt, opts) {
      prompts.push(prompt);
      systems.push(opts?.system ?? "");
      const examples = [...(opts?.system ?? "").matchAll(/\{[^{}]*"ref"[^{}]*\}/g)].map(match => parseDecision(match[0]));
      const click = examples.find(decision => decision.action === "click" && decision.text === undefined && decision.role === undefined && decision.nth === undefined);
      const row = prompt.split("\n").find(line => line.includes("ref=") && line.includes("nth=1"))!;
      return click ? JSON.stringify({ ...click, ref: promptRef(row) }) : '{"action":"done"}';
    },
  };
  const original = { kind: "click" as const, target: { text: "Old save" }, intent: "save the second record", expect: { text: "Saved" } };
  const result = await new LlmStepHealer(llm).heal(original, 2, driver);
  expect(prompts).toHaveLength(1);
  expect(systems[0]).toContain(ACTION_VOCABULARY);
  expect(systems[0]).toContain(ACTION_RULES);
  expect(systems[0]).toContain(PERCEPTION_RULES);
  expect(systems[0]).toMatch(/ref[\s\S]{0,160}(?:current|this) (?:observation|decision)/i);
  expect(systems[0]).toMatch(/(?:without|omit|optional)[\s\S]{0,100}(?:text|role|nth)/i);
  expect(driver.exact).toEqual(["second"]);
  expect(result).toEqual({ index: 2, step: { kind: "click", target: { text: "Save", role: "button", selector: "#second" }, intent: original.intent, expect: original.expect } });
  expect(JSON.stringify(result)).not.toContain('"ref"');
});

function expectNamedInstructions(system: string): void {
  expect(system).toContain('No references are available in this observation');
  expect(system).toContain('do not include "ref"');
  expect(system).not.toContain('"ref":"<ref>"');
  expect(system).not.toContain('choose it from the current reference table');
  for (const action of ["click", "doubleClick", "hover", "type", "select"]) {
    expect(system).toContain(`{"action":"${action}","text":"<element>"`);
  }
  expect(system).toContain('always add "role"');
  expect(system).toContain('duplicate WITHOUT nth is rejected');
}

it.each(["legacy", "unreferenced", "empty", "filtered"] as const)(
  "referenceFreeInstructions: %s observations teach named actions in both loops and step healing", async mode => {
    for (const flow of ["discover", "explore", "step-heal"] as const) {
      const driver = mode === "legacy" ? new StubDriver() : new PromptRefDriver();
      driver.els = mode === "empty" ? [] : [{ role: "button", name: "Save",
        ...(mode === "legacy" || mode === "filtered" ? { ref: "node-save" } : {}),
        ...(mode === "filtered" ? { occluded: true } : {}),
      }];
      const systems: string[] = [];
      const llm: LlmClient = { id: "named-instructions", async complete(_prompt, opts) {
        systems.push(opts?.system ?? "");
        return '{"action":"done"}';
      } };
      if (flow === "step-heal") {
        await new LlmStepHealer(llm).heal({ kind: "click", target: { text: "Old" }, intent: "submit" }, 0, driver);
      } else await runPromptLoop(flow, driver, llm);
      expectNamedInstructions(systems[0]!);
      expect(driver.clicked).toEqual([]);
    }
  },
);

it("namedInstructionsExecuteWithoutAReferenceRetry: both loops select by name and freeze the target", async () => {
  for (const mode of ["discover", "explore"] as const) {
    const driver = new StubDriver();
    driver.els = [{ role: "button", name: "Save" }];
    driver.navOn.Save = "https://app/saved";
    let decisions = 0;
    const llm: LlmClient = { id: "named-schema", async complete(prompt, opts) {
      if (!prompt.includes("What is the single next action?")) return "[]";
      expectNamedInstructions(opts?.system ?? "");
      return ++decisions === 1 ? '{"action":"click","text":"Save","role":"button"}' : '{"action":"done"}';
    } };
    const result = await runPromptLoop(mode, driver, llm);
    expect(result.truncated).not.toBe(true);
    expect(decisions).toBe(2);
    expect(driver.clicked).toEqual(["Save"]);
    expect(result.steps.find(step => step.kind === "click")).toMatchObject({ target: { text: "Save", role: "button" } });
  }
});

it("referenceInstructionsTrackEachObservation: refs can disappear and return without changing driver capability", async () => {
  for (const mode of ["discover", "explore"] as const) {
    const driver = new PromptRefDriver();
    const llm = new PromptRecordingLlm((_prompt, turn) => {
      driver.els = [{ role: "button", name: "Save", ...(turn === 1 ? {} : { ref: "node-save" }) }];
      return turn < 3 ? '{"action":"pressKey","key":"Escape"}' : '{"action":"done"}';
    });
    await runPromptLoop(mode, driver, llm);
    expect(llm.systems).toHaveLength(3);
    expect(llm.systems[0]).toContain(ACTION_VOCABULARY);
    expectNamedInstructions(llm.systems[1]!);
    expect(llm.systems[2]).toContain(ACTION_VOCABULARY);
  }
});

it("namedStepHealKeepsOriginalChecks: a reference-free duplicate repair retains ordinal, intent and expect", async () => {
  const driver = new StubDriver();
  driver.els = [{ role: "button", name: "Save" }, { role: "button", name: "Save" }];
  const step = { kind: "click" as const, target: { text: "Old" }, intent: "save", expect: { text: "Saved" } };
  const llm: LlmClient = { id: "named-repair", async complete(_prompt, opts) {
    expectNamedInstructions(opts?.system ?? "");
    return '{"action":"click","text":"Save","role":"button","nth":1}';
  } };
  const result = await new LlmStepHealer(llm).heal(step, 0, driver);
  expect(driver.clicked).toEqual(["Save"]);
  expect(result?.step).toMatchObject({ target: { text: "Save", role: "button", nth: 1 }, intent: step.intent, expect: step.expect });
});

it("inventedReferenceStillFailsClosed: named guidance does not turn a forged ref into a fallback or parse retry", async () => {
  for (const mode of ["discover", "explore"] as const) {
    const driver = new StubDriver();
    driver.els = [{ role: "button", name: "Save" }];
    const gates: string[] = [];
    const llm = new PromptRecordingLlm((_prompt, turn) => turn === 1
      ? '{"action":"click","text":"Save","ref":"forged"}'
      : turn === 2 ? '{"action":"click","text":"Save","role":"button"}' : '{"action":"done"}');
    const opts = { driver, llm, baseUrl: "https://app/start", maxSteps: 4,
      trace: startTrace({ emit: event => {
        if (event.kind === "gate") gates.push(event.payload.gate);
      } }, "test").scope("named"),
    };
    const result = mode === "discover" ? await discover("save", opts) : await explore("save", opts);
    expect(result.truncated).not.toBe(true);
    expect(gates).toContain("reference-binding");
    expect(gates).not.toContain("parse-retry");
    expect(driver.clicked).toEqual(["Save"]);
    expect(llm.prompts).toHaveLength(3);
    expect(llm.prompts[1]).toContain("unknown or expired observation reference");
  }
});
