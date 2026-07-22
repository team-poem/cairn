import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { TRACE_VERSION, assertionPayload, startTrace } from "../../src/core/trace.js";
import { ENGINE_VERSION } from "../../src/version.js";
import type { TraceEvent } from "../../src/core/trace.js";

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

describe("ENGINE_VERSION", () => {
  it("matches the harness package.json version", () => {
    const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };
    expect(ENGINE_VERSION).toBe(pkg.version);
  });
});
