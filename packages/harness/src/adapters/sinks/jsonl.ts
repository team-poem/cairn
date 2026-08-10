/**
 * `TraceSink` → a JSONL artifact: one event per line, in `seq` order.
 *
 * The stored counterpart of the live stream — spec/core/trace.md §One line: "the live stream and
 * the stored trace are two serializations of the same model". The engine ships both so persistence
 * is one format rather than one per embedder.
 *
 * The sink contract (ports.ts) is sync fire-and-forget and must never fail a run, so `emit` only
 * buffers and swallows: the disk write happens on a serialized queue behind it, and `close()` is
 * what waits.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TraceSink } from "../../core/ports.js";
import type { TraceEvent } from "../../core/trace.js";

export class JsonlTraceSink implements TraceSink {
  /**
   * Every event this sink saw, in order — so a host can project the run without re-reading the
   * file it just wrote. Retained for the whole run: a trace is small per event, but a long suite
   * holds them all, and a host that does not need them can read the file instead.
   */
  readonly events: TraceEvent[] = [];
  #pending: string[] = [];
  #queue: Promise<void> = Promise.resolve();
  #failures = 0;
  #path: string | undefined;
  #runId: string | undefined;

  /**
   * The path is resolved from the header's own `runId` rather than supplied up front, so the run
   * has exactly one identity — the engine's — instead of a file name and a header disagreeing.
   * `startTrace` emits the header synchronously, so `runId`/`path` are set before it returns.
   */
  constructor(private readonly resolvePath: (runId: string) => string) {}

  get runId(): string | undefined {
    return this.#runId;
  }

  get path(): string | undefined {
    return this.#path;
  }

  /** Writes that failed. Surfaced rather than hidden: a truncated trace must not read as a clean one. */
  get failures(): number {
    return this.#failures;
  }

  emit(event: TraceEvent): void {
    try {
      if (event.kind === "trace" && this.#runId === undefined) {
        this.#runId = event.payload.runId;
        this.#path = this.resolvePath(event.payload.runId);
      }
      this.events.push(event);
      this.#pending.push(JSON.stringify(event));
      this.#schedule();
    } catch {
      // A trace is evidence, not control flow — a sink that throws would change a verdict.
      this.#failures += 1;
    }
  }

  /** Flush everything still buffered. Call once, when the run is over. */
  async close(): Promise<void> {
    this.#schedule();
    await this.#queue;
  }

  #schedule(): void {
    this.#queue = this.#queue.then(() => this.#flush()).catch(() => {
      this.#failures += 1;
    });
  }

  async #flush(): Promise<void> {
    const path = this.#path;
    // No header yet means no identity yet — hold the events rather than inventing a file name.
    if (!path || !this.#pending.length) return;
    const chunk = `${this.#pending.splice(0).join("\n")}\n`;
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, chunk, "utf8");
  }
}
