import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { TRACE_VERSION, assertionPayload, startTrace } from "../../src/core/trace.js";
import { ENGINE_VERSION } from "../../src/version.js";
import type { TraceEvent } from "../../src/core/trace.js";
import type { TraceAttachment, TraceSink } from "../../src/core/ports.js";

class RecordingSink {
  events: TraceEvent[] = [];
  emit(e: TraceEvent): void {
    this.events.push(e);
  }
}

describe("Tracer", () => {
  it("startTrace emits the seq-0 header with version/runId/engine", () => {
    const sink = new RecordingSink();
    startTrace(sink, "2.5.0");
    expect(sink.events).toHaveLength(1);
    const header = sink.events[0]!;
    expect(header.seq).toBe(0);
    expect(header.kind).toBe("trace");
    expect(header.phase).toBeUndefined();
    if (header.kind !== "trace") throw new Error("unreachable");
    expect(header.payload.version).toBe(TRACE_VERSION);
    expect(header.payload.runId).toMatch(/[0-9a-f-]{36}/);
    expect(header.payload.engine).toEqual({ name: "cairn", version: "2.5.0" });
  });

  it("stamps monotonic seq and epoch-ms ts on every event", () => {
    const sink = new RecordingSink();
    const tracer = startTrace(sink, "2.5.0");
    const before = Date.now();
    tracer.emit({ kind: "run-end", payload: { passed: true } });
    tracer.emit({ kind: "run-end", payload: { passed: false } });
    expect(sink.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(sink.events[1]!.ts).toBeGreaterThanOrEqual(before);
    expect(sink.events[2]!.ts).toBeGreaterThanOrEqual(sink.events[1]!.ts);
  });

  it("scope stamps caseRef, shares the seq counter, and passes phase/stepRef through", () => {
    const sink = new RecordingSink();
    const tracer = startTrace(sink, "2.5.0");
    const scope = tracer.scope("login");
    scope.emit({
      kind: "step",
      phase: "replay",
      stepRef: 3,
      payload: { step: { kind: "scroll" }, ok: true },
    });
    const e = sink.events[1]!;
    expect(e.caseRef).toBe("login");
    expect(e.seq).toBe(1);
    expect(e.phase).toBe("replay");
    expect(e.stepRef).toBe(3);
  });

  it("a throwing sink is swallowed — emit never throws", () => {
    const tracer = startTrace(
      {
        emit: () => {
          throw new Error("disk full");
        },
      },
      "2.5.0",
    );
    expect(() => tracer.emit({ kind: "run-end", payload: { passed: true } })).not.toThrow();
  });
});

describe("assertionPayload", () => {
  it("surfaces a missing origin as 'unknown', never guesses", () => {
    const p = assertionPayload({ assertion: { kind: "no-console-errors" }, passed: true });
    expect(p.origin).toBe("unknown");
  });

  it("keeps a stamped origin", () => {
    const p = assertionPayload({
      assertion: { kind: "navigated", origin: "derived" },
      passed: true,
    });
    expect(p.origin).toBe("derived");
  });

  it("maps checkedBy: 'expect' is model-judged, everything else is code", () => {
    const model = assertionPayload({
      assertion: { kind: "expect", criterion: "cart shows one item", origin: "user" },
      passed: false,
      detail: "cart was empty",
    });
    expect(model).toMatchObject({ checkedBy: "model", origin: "user", passed: false, detail: "cart was empty" });
    const code = assertionPayload({ assertion: { kind: "no-failed-requests", origin: "derived" }, passed: true });
    expect(code.checkedBy).toBe("code");
  });
});

class AttachingSink extends RecordingSink {
  attachments: TraceAttachment[] = [];
  attach(a: TraceAttachment): void {
    this.attachments.push(a);
  }
}

const stepEvent = (stepRef: number) =>
  ({ kind: "step", phase: "replay", stepRef, payload: { step: { kind: "pressKey", key: "Enter" }, ok: true } }) as const;

describe("Tracer — attachments (#160)", () => {
  it("derives the attachment id from the event's own seq and hands the bytes to the sink", () => {
    const sink = new AttachingSink();
    const tracer = startTrace(sink, ENGINE_VERSION);
    tracer.emit(stepEvent(0), "data:image/png;base64,AAAA");

    const event = sink.events[1]!;
    if (event.kind !== "step") throw new Error("unreachable");
    expect(event.payload.attachment).toBe(String(event.seq));
    // The ref in the trace and the key the bytes were filed under are the same string, by construction.
    expect(sink.attachments).toEqual([{ id: String(event.seq), data: "data:image/png;base64,AAAA" }]);
  });

  it("gives a healed step's two frames two attachments, not one overwriting the other", () => {
    // The reason the id is seq-derived rather than (caseRef, stepRef): a heal re-runs a step, so
    // the same stepRef legitimately produces two frames. Correlation by reference would keep one.
    const sink = new AttachingSink();
    const tracer = startTrace(sink, ENGINE_VERSION);
    tracer.emit(stepEvent(3), "data:image/png;base64,BROKE");
    tracer.emit(stepEvent(3), "data:image/png;base64,HEALED");

    const ids = sink.events.filter((e) => e.kind === "step").map((e) => (e.kind === "step" ? e.payload.attachment : ""));
    expect(new Set(ids).size).toBe(2);
    expect(sink.attachments.map((a) => a.data)).toEqual(["data:image/png;base64,BROKE", "data:image/png;base64,HEALED"]);
  });

  it("emits no attachment ref to a sink that does not store bytes", () => {
    const sink = new RecordingSink();
    const tracer = startTrace(sink, ENGINE_VERSION);
    expect(tracer.acceptsAttachments).toBe(false);
    tracer.emit(stepEvent(0), "data:image/png;base64,AAAA");

    const event = sink.events[1]!;
    if (event.kind !== "step") throw new Error("unreachable");
    // A ref nothing can resolve is worse than no ref: the field stays absent (§Attachments).
    expect(event.payload.attachment).toBeUndefined();
  });

  it("carries attachments through a scope, and only on step events", () => {
    const sink = new AttachingSink();
    const tracer = startTrace(sink, ENGINE_VERSION);
    const scope = tracer.scope("cart");
    expect(scope.acceptsAttachments).toBe(true);
    scope.emit(stepEvent(1), "data:image/png;base64,AAAA");
    scope.emit({ kind: "case-end", payload: { verdict: { passed: true, results: [] }, discovered: false, heals: 0 } }, "data:image/png;base64,BBBB");

    const step = sink.events[1]!;
    if (step.kind !== "step") throw new Error("unreachable");
    expect(step.caseRef).toBe("cart");
    expect(step.payload.attachment).toBe("1");
    expect(sink.attachments).toHaveLength(1); // the case-end's bytes were not filed
  });

  it("swallows a sink that throws while taking attachment bytes", () => {
    const sink: TraceSink = {
      emit: () => {},
      attach: () => {
        throw new Error("disk on fire");
      },
    };
    const tracer = startTrace(sink, ENGINE_VERSION);
    expect(() => tracer.emit(stepEvent(0), "data:image/png;base64,AAAA")).not.toThrow();
  });
});

describe("ENGINE_VERSION", () => {
  it("matches the harness package.json version", () => {
    const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };
    expect(ENGINE_VERSION).toBe(pkg.version);
  });
});
