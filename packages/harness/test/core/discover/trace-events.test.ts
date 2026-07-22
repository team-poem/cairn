import { describe, expect, it } from "vitest";
import { discover } from "../../../src/core/discover/index.js";
import type { ActionPolicy, Decision } from "../../../src/core/discover/index.js";
import { startTrace } from "../../../src/core/trace.js";
import type { TraceEvent } from "../../../src/core/trace.js";
import { FakeDriver } from "../../../src/adapters/drivers/fake.js";
import { ScriptedLlm } from "../../support/doubles.js";
import type { Evidence } from "../../../src/core/types.js";

class RecordingSink {
  events: TraceEvent[] = [];
  emit(e: TraceEvent): void {
    this.events.push(e);
  }
}

const evidence: Evidence = {
  execution: { actions: [], navigated: true, finalUrl: "https://shop/cart", blocked: false },
  perception: {},
  logic: { requests: [], console: [] },
};

/** A scope over a fresh trace; the sink's first event is always the startTrace header. */
function scoped(caseRef = "c1"): { sink: RecordingSink; scope: ReturnType<ReturnType<typeof startTrace>["scope"]> } {
  const sink = new RecordingSink();
  return { sink, scope: startTrace(sink, "0.0.0").scope(caseRef) };
}

describe("discover trace events", () => {
  it("emits action per executed step and action{done} on the done decision, phase discover", async () => {
    const { sink, scope } = scoped();
    const driver = new FakeDriver({ evidence, elements: [{ role: "button", name: "Go" }] });
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Go","reason":"start the flow"}',
      '{"action":"done","reason":"landed"}',
    ]);
    await discover("t", { driver, llm, trace: scope });
    const actions = sink.events.filter((e) => e.kind === "action");
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      phase: "discover",
      caseRef: "c1",
      stepRef: 0,
      payload: { ok: true, intent: "start the flow" },
    });
    expect(actions[1]!.payload).toMatchObject({ done: true, ok: true, intent: "landed" });
    // the header stays seq 0; every discover event carries a monotonic seq after it
    expect(sink.events.map((e) => e.seq)).toEqual(sink.events.map((_, i) => i));
  });

  it("a failed apply emits action{ok:false} with the error", async () => {
    const { sink, scope } = scoped();
    const driver = new FakeDriver({ evidence, elements: [{ role: "link", name: "Gone" }], failOn: ["Gone"] });
    const llm = new ScriptedLlm(['{"action":"click","text":"Gone","reason":"try it"}', '{"action":"done"}']);
    await discover("t", { driver, llm, trace: scope });
    const failed = sink.events.find((e) => e.kind === "action" && !(e.payload as { ok: boolean }).ok);
    expect(failed).toBeDefined();
    expect(failed!.payload).toMatchObject({ ok: false, intent: "try it" });
    expect((failed!.payload as { error: string }).error).toContain("element not found");
    expect(failed!.stepRef).toBeUndefined(); // nothing was frozen for it
  });

  it("emits gate events for parse-retry, ambiguity, and policy blocks", async () => {
    const { sink, scope } = scoped();
    const driver = new FakeDriver({
      evidence,
      elements: [
        { role: "button", name: "Del" },
        { role: "button", name: "Del" },
      ],
    });
    const llm = new ScriptedLlm([
      "not json at all",
      '{"action":"click","text":"Del"}', // ambiguous: two buttons named "Del", no nth
      '{"action":"click","text":"Del","role":"button","nth":0}', // unambiguous — policy blocks it
      '{"action":"done"}',
    ]);
    const policy: ActionPolicy = {
      vet: (d: Decision) => (d.text === "Del" ? { ok: false, reason: "destructive" } : { ok: true }),
    };
    await discover("t", { driver, llm, trace: scope, policy });
    const gates = sink.events.filter((e) => e.kind === "gate");
    expect(gates.map((e) => (e.payload as { gate: string }).gate)).toEqual(["parse-retry", "ambiguity", "policy"]);
    expect(gates[1]!.payload).toMatchObject({ action: 'click "Del"' });
    expect((gates[1]!.payload as { reason: string }).reason).toContain('named "Del"');
    expect(gates[2]!.payload).toMatchObject({ action: 'click "Del"', reason: "destructive" });
    // gated decisions never became steps or step-actions
    expect(sink.events.filter((e) => e.kind === "action" && !(e.payload as { done?: boolean }).done)).toHaveLength(0);
  });

  it("emits gate{grounding} when a proposed assertion is dropped at the freeze", async () => {
    const { sink, scope } = scoped();
    const driver = new FakeDriver({ evidence, elements: [] }); // no requests captured
    const llm = new ScriptedLlm([
      '{"action":"done","assertions":[{"kind":"request-status","urlIncludes":"/api/x","status":200}]}',
    ]);
    await discover("t", { driver, llm, trace: scope });
    const drop = sink.events.find((e) => e.kind === "gate" && (e.payload as { gate: string }).gate === "grounding");
    expect(drop).toBeDefined();
    expect(drop!.phase).toBe("discover");
    expect((drop!.payload as { reason: string }).reason).toContain("no captured request");
    expect((drop!.payload as { action: string }).action).toContain("/api/x");
  });

  it("tracePhase: 'heal' stamps every event with phase heal", async () => {
    const { sink, scope } = scoped();
    const driver = new FakeDriver({ evidence, elements: [{ role: "button", name: "Go" }] });
    const llm = new ScriptedLlm(['{"action":"click","text":"Go"}', '{"action":"done"}']);
    await discover("t", { driver, llm, trace: scope, tracePhase: "heal" });
    const emitted = sink.events.slice(1); // skip the startTrace header (no phase by contract)
    expect(emitted.length).toBeGreaterThan(0);
    for (const e of emitted) expect(e.phase).toBe("heal");
  });

  it("emits nothing extra and behaves identically without a trace option", async () => {
    const driver = new FakeDriver({ evidence, elements: [{ role: "button", name: "Go" }] });
    const llm = new ScriptedLlm(['{"action":"click","text":"Go"}', '{"action":"done"}']);
    const scenario = await discover("t", { driver, llm });
    expect(scenario.name).toBe("t");
    expect(scenario.steps).toHaveLength(1);
  });
});
