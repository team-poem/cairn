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
