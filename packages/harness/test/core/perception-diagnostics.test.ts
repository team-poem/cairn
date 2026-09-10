// file: packages/harness/test/core/perception-diagnostics.test.ts
import { expect, it } from "vitest";
import { discover } from "../../src/core/discover/index.js";
import { explore } from "../../src/core/explore/index.js";
import type { LlmClient, PerceptionAdapter } from "../../src/core/ports.js";
import type { Target } from "../../src/core/types.js";
import { startTrace, type TraceEvent, type TraceScope } from "../../src/core/trace.js";
import { StubDriver } from "../support/doubles.js";

class DiagnosticDriver extends StubDriver {
  readonly refs: string[] = [];
  constructor() {
    super();
    this.els = [{ role: "button", name: "Save", ref: "private-driver-token" }];
  }
  async locateRef(ref: string): Promise<Target> {
    const row = this.els.find(e => e.ref === ref);
    if (!row) throw new Error("unknown driver ref");
    return { text: row.name, role: row.role, selector: "#save" };
  }
  override async click(target: Target, ref?: string): Promise<void> {
    if (!ref) throw new Error("unexpected legacy fallback");
    this.refs.push(ref);
    await super.click(target);
  }
}
class DiagnosticLlm implements LlmClient {
  readonly id = "diagnostic-scripted";
  readonly prompts: string[] = [];
  constructor(private readonly reply: (prompt: string, turn: number) => string = () => '{"action":"done"}') {}
  async complete(prompt: string): Promise<string> {
    if (!prompt.includes("What is the single next action?")) return "[]";
    this.prompts.push(prompt);
    return this.reply(prompt, this.prompts.length);
  }
}
function diagnosticRef(prompt: string): string {
  const ref = prompt.match(/ref="([^"]+)"/)?.[1];
  if (!ref) throw new Error("missing model reference");
  return ref;
}
function diagnosticTrace() {
  const events: TraceEvent[] = [];
  const scope = startTrace({ emit(event) { events.push(event); } }, "test").scope("diagnostic-case");
  return { events, scope };
}
function diagnosticGates(events: TraceEvent[]) {
  return events.filter(event => event.kind === "gate");
}
async function diagnosticLoop(mode: "discover" | "explore", driver: DiagnosticDriver, llm: LlmClient, trace: TraceScope, perceive?: PerceptionAdapter, maxSteps = 3) {
  const options = { driver, llm, trace, perceive, baseUrl: "https://app/start", maxSteps };
  return mode === "discover" ? discover("save", options) : explore("save", options);
}

it("invalidPerceptionIsTraceVisibleAtExhaustion: each rejected capture is diagnosed even when no model decision is possible", async () => {
  for (const mode of ["discover", "explore"] as const) {
    const driver = new DiagnosticDriver();
    const llm = new DiagnosticLlm();
    const { events, scope } = diagnosticTrace();
    let captures = 0;
    const result = await diagnosticLoop(mode, driver, llm, scope, rows => {
      captures++;
      return rows.map(row => ({ ...row, role: "link" }));
    });
    expect(result.truncated).toBe(true);
    expect(captures).toBe(3);
    expect(llm.prompts).toEqual([]);
    expect(driver.refs).toEqual([]);
    const gates = diagnosticGates(events);
    expect(gates).toHaveLength(3);
    for (const gate of gates) {
      expect(gate).toMatchObject({ phase: mode, caseRef: "diagnostic-case", payload: { gate: "perception-binding" } });
      expect(gate.payload.reason).toMatch(/perception|binding/i);
      expect(gate.payload.action).toBeUndefined();
      expect(gate.stepRef).toBeUndefined();
    }
    expect(events.filter(event => event.kind === "action")).toEqual([]);
    expect(result.steps.filter(step => step.kind !== "goto")).toEqual([]);
  }
});

it("recoveredPerceptionRetainsItsDiagnostic: a later valid capture can act without erasing the rejected turn", async () => {
  for (const mode of ["discover", "explore"] as const) {
    const driver = new DiagnosticDriver();
    const { events, scope } = diagnosticTrace();
    let captures = 0;
    const capturesAtDecision: number[] = [];
    const llm = new DiagnosticLlm((prompt, turn) => {
      capturesAtDecision.push(captures);
      return turn === 1 ? JSON.stringify({ action: "click", ref: diagnosticRef(prompt) }) : '{"action":"done"}';
    });
    const result = await diagnosticLoop(mode, driver, llm, scope, rows => {
      captures++;
      return captures === 1 ? rows.map(row => ({ ...row, name: "Changed" })) : rows;
    });
    expect(result.truncated).not.toBe(true);
    expect(capturesAtDecision).toEqual([2, 3]);
    expect(driver.refs).toEqual(["private-driver-token"]);
    expect(diagnosticGates(events)).toHaveLength(1);
    expect(diagnosticGates(events)[0]).toMatchObject({ phase: mode, payload: { gate: "perception-binding" } });
    expect(llm.prompts[0]).toMatch(/perception binding rejected/i);
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index));
  }
});

it("invalidReferenceHasItsOwnGate: valid JSON with an unknown or contradictory reference is visible without being mislabeled as a parse failure", async () => {
  for (const mode of ["discover", "explore"] as const) {
    for (const choice of ["unknown", "contradictory", "non-string"] as const) {
      const driver = new DiagnosticDriver();
      const { events, scope } = diagnosticTrace();
      const llm = new DiagnosticLlm((prompt, turn) => {
        if (turn > 1) return '{"action":"done"}';
        return JSON.stringify({ action: "click", ref: choice === "unknown" ? "forged" : diagnosticRef(prompt),
          ...(choice === "contradictory" ? { role: "link" } : {}), ...(choice === "non-string" ? { text: 42 } : {}) });
      });
      const result = await diagnosticLoop(mode, driver, llm, scope);
      expect(result.truncated).not.toBe(true);
      expect(driver.refs).toEqual([]);
      const gates = diagnosticGates(events);
      expect(gates).toHaveLength(1);
      expect(gates[0]).toMatchObject({ phase: mode, caseRef: "diagnostic-case", payload: { gate: "reference-binding" } });
      expect(gates[0]!.payload.reason).toMatch(/reference|binding/i);
      expect(gates[0]!.stepRef).toBeUndefined();
      expect(llm.prompts[1]).not.toContain("not a single valid JSON action object");
    }
  }
});

it("bindingDiagnosticsDoNotEchoUntrustedData: a rejected reply cannot expose its ref, description, reason, or input value through the gate", async () => {
  for (const mode of ["discover", "explore"] as const) {
    const driver = new DiagnosticDriver();
    const { events, scope } = diagnosticTrace();
    const markers = ["PRIVATE_REF_221", "PRIVATE_TEXT_221", "PRIVATE_REASON_221", "PRIVATE_VALUE_221"];
    const llm = new DiagnosticLlm(() => JSON.stringify({ action: "type", ref: markers[0], text: markers[1], reason: markers[2], value: markers[3] }));
    const result = await diagnosticLoop(mode, driver, llm, scope, undefined, 1);
    expect(result.truncated).toBe(true);
    const gates = diagnosticGates(events);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ payload: { gate: "reference-binding" } });
    const serialized = JSON.stringify(gates);
    for (const marker of [...markers, "private-driver-token"]) expect(serialized).not.toContain(marker);
    expect(driver.refs).toEqual([]);
  }
});

it("throwingDiagnosticSinkDoesNotChangeRecovery: trace failures remain observational while rejected captures still attempt emission", async () => {
  for (const mode of ["discover", "explore"] as const) {
    const driver = new DiagnosticDriver();
    let gateAttempts = 0;
    const scope = startTrace({ emit(event) {
      if (event.kind === "gate") { gateAttempts++; throw new Error("sink unavailable"); }
    } }, "test").scope("throwing-sink");
    let captures = 0;
    const llm = new DiagnosticLlm();
    const result = await diagnosticLoop(mode, driver, llm, scope, rows => {
      captures++;
      return captures === 1 ? rows.map(row => ({ ...row, role: "link" })) : rows;
    });
    expect(result.truncated).not.toBe(true);
    expect(llm.prompts).toHaveLength(1);
    expect(gateAttempts).toBe(1);
  }
});
