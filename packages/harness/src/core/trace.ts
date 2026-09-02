/**
 * The lifecycle event stream (spec/core/trace.md): everything a run does becomes one flat,
 * ordered, versioned sequence of events. `TraceSink` (ports.ts) is the port a host implements;
 * this module owns the envelope — seq/ts stamping, the seq-0 header, per-case scoping. Emission
 * is fire-and-forget: a sink that throws is swallowed, a trace must never change a verdict.
 */
import type { TraceSink } from "./ports.js";
import type { Assertion, AssertionResult, RunUsage, Step, Target, Verdict } from "./types.js";

/** Header `major.minor` (spec/core/trace.md §Versioning): minor = additive, major = envelope change.
 * 1.1 — `step.payload.attachment` (#160), an optional new field: readers of 1.0 skip it. */
export const TRACE_VERSION = "1.1";

export type TracePhase = "discover" | "replay" | "heal";

interface Envelope {
  /** Total order, monotonic per trace; 0 is always the `trace` header. */
  seq: number;
  /** Wall clock, epoch ms. */
  ts: number;
  /** Absent on lifecycle events (trace / case / run-end). */
  phase?: TracePhase;
  /** `SuiteCase.id` (or scenario name for a bare run); absent on run-level events. */
  caseRef?: string;
  /** Step index in the (frozen) scenario. */
  stepRef?: number;
}

export type TraceEvent = Envelope &
  (
    | { kind: "trace"; payload: { version: string; runId: string; engine: { name: "cairn"; version: string } } }
    | { kind: "run-end"; payload: { passed: boolean; usage?: RunUsage } }
    | { kind: "case-start"; payload: { id: string; intent: string; skillRef?: string; cached: boolean } }
    | {
        kind: "case-end";
        payload: { verdict: Verdict; usage?: RunUsage; discovered: boolean; heals: number; truncated?: boolean };
      }
    /** A discover-loop decision: an executed/failed step, or the model's `done` (no `step`). */
    | { kind: "action"; payload: { step?: Step; intent?: string; ok: boolean; error?: string; done?: boolean } }
    /** A gate firing — the engine did something different than asked, and says so (trust: no silence). */
    | {
        kind: "gate";
        payload: { gate: "policy" | "ambiguity" | "grounding" | "parse-retry" | "unproven-action"; action?: string; reason: string };
      }
    /** Emitted by the freeze CALLER (the suite owns `caseHash` — pattern ≠ data, core never reads it). */
    | {
        kind: "freeze";
        payload: {
          ref: string;
          caseHash?: string;
          assertions: { user: number; derived: number; unknown: number };
          truncated?: boolean;
        };
      }
    /** `attachment` is a ref, never bytes (§Attachments) — stamped by the Tracer from this event's
     * own `seq`, so call sites hand `emit` the bytes and never the id. */
    | { kind: "step"; payload: { step: Step; ok: boolean; skipped?: boolean; error?: string; attachment?: string } }
    | {
        kind: "assertion";
        payload: {
          assertion: Assertion;
          passed: boolean;
          detail?: string;
          origin: "user" | "derived" | "unknown";
          checkedBy: "code" | "model";
        };
      }
    | {
        kind: "heal";
        payload:
          | { layer: "locator"; broke: Target; became: Target; judgedBy: "original" }
          | { layer: "step"; broke: Step; became: Step; judgedBy: "original" };
      }
  );

type DistributedOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** What call sites pass to `emit` — the envelope stamps (`seq`, `ts`) are the Tracer's job. */
export type TraceEmission = DistributedOmit<TraceEvent, "seq" | "ts">;

/** Build an `assertion` event payload from a judged result. origin absent = frozen before
 * provenance shipped → "unknown", never guessed (fail-closed); `expect` is the only
 * model-judged kind (invariant #4). */
export function assertionPayload(r: AssertionResult): Extract<TraceEvent, { kind: "assertion" }>["payload"] {
  return {
    assertion: r.assertion,
    passed: r.passed,
    detail: r.detail,
    origin: r.assertion.origin ?? "unknown",
    checkedBy: r.assertion.kind === "expect" ? "model" : "code",
  };
}

/** Owns one trace's envelope: the seq counter, ts stamping, and sink error isolation. Not a port —
 * the port is `TraceSink`; a Tracer only exists when a host passed one (absent sink = no Tracer,
 * call sites no-op via `?.`). */
export class Tracer {
  #seq = 0;
  readonly #sink: TraceSink;

  constructor(sink: TraceSink) {
    this.#sink = sink;
  }

  /** True when the sink stores attachment bytes. Call sites check it before *capturing* bytes at
   * all — a screenshot nobody stores should never be taken (same zero-cost stance as no sink). */
  get acceptsAttachments(): boolean {
    return typeof this.#sink.attach === "function";
  }

  /**
   * `attachmentData` is a data URL the event refers to; the id is derived from this event's own
   * `seq` (§Attachments), which is why the Tracer stamps it and not the call site — `seq` is
   * unique and totally ordered, so a healed step's two frames stay two attachments instead of
   * one overwriting the other.
   */
  emit(event: TraceEmission, attachmentData?: string): void {
    // A sink must never fail the run: swallow, don't rethrow — tracing is evidence, not control flow.
    try {
      const stamped = { ...event, seq: this.#seq++, ts: Date.now() } as TraceEvent;
      if (attachmentData !== undefined && stamped.kind === "step" && this.#sink.attach) {
        const id = String(stamped.seq);
        // Bytes first, then the line that references them: a run cut short between the two leaves
        // an unreferenced sidecar (harmless) rather than a reference that resolves to nothing.
        this.#sink.attach({ id, data: attachmentData });
        this.#sink.emit({ ...stamped, payload: { ...stamped.payload, attachment: id } });
        return;
      }
      this.#sink.emit(stamped);
    } catch {
      /* deliberately ignored */
    }
  }

  /** Flat correlation, not containment: a scope only stamps `caseRef`, the seq counter is shared. */
  scope(caseRef: string): TraceScope {
    return new TraceScope(this, caseRef);
  }
}

export class TraceScope {
  readonly #tracer: Tracer;
  readonly caseRef: string;

  constructor(tracer: Tracer, caseRef: string) {
    this.#tracer = tracer;
    this.caseRef = caseRef;
  }

  /** True when the sink stores attachment bytes (see `Tracer.acceptsAttachments`). */
  get acceptsAttachments(): boolean {
    return this.#tracer.acceptsAttachments;
  }

  emit(event: TraceEmission, attachmentData?: string): void {
    this.#tracer.emit({ ...event, caseRef: this.caseRef } as TraceEmission, attachmentData);
  }
}

/** Open a trace: build the Tracer and emit the seq-0 header — the only way to construct one,
 * so `seq: 0` is the header by construction, in every serialization. */
export function startTrace(sink: TraceSink, engineVersion: string): Tracer {
  const tracer = new Tracer(sink);
  tracer.emit({
    kind: "trace",
    // globalThis.crypto, not node:crypto — core/ stays free of node builtins (the browser entry
    // exports runHarness, which imports this module); Web Crypto exists in Node 19+ and browsers.
    payload: { version: TRACE_VERSION, runId: globalThis.crypto.randomUUID(), engine: { name: "cairn", version: engineVersion } },
  });
  return tracer;
}
