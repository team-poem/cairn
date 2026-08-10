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
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { TraceAttachment, TraceSink } from "../../core/ports.js";
import type { TraceEvent } from "../../core/trace.js";

/** `data:<mediaType>[;base64],<payload>` — the shape `Driver.screenshot()` returns. */
const DATA_URL = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "text/plain": "txt",
  "text/html": "html",
  "application/json": "json",
};

/** Extension for a media type: a known one, else its sanitized subtype, else `bin`. A reader
 * resolves an attachment by globbing `<id>.*`, so the extension is a convenience, not an index. */
function extensionFor(mediaType: string): string {
  const known = EXTENSIONS[mediaType];
  if (known) return known;
  const subtype = mediaType.split("/")[1]?.split("+").pop()?.replace(/[^a-z0-9]/gi, "") ?? "";
  return subtype.length ? subtype.toLowerCase() : "bin";
}

function decodeDataUrl(data: string): { bytes: Buffer; mediaType: string } | undefined {
  const match = DATA_URL.exec(data);
  if (!match) return undefined;
  const mediaType = match[1] || "text/plain";
  const body = match[3] ?? "";
  const bytes = match[2] ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8");
  return { bytes, mediaType };
}

export class JsonlTraceSink implements TraceSink {
  /**
   * Every event this sink saw, in order — so a host can project the run without re-reading the
   * file it just wrote. Retained for the whole run: a trace is small per event, but a long suite
   * holds them all, and a host that does not need them can read the file instead.
   */
  readonly events: TraceEvent[] = [];
  #pending: string[] = [];
  #pendingAttachments: TraceAttachment[] = [];
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

  /**
   * Where this run's attachment bytes land: the trace file's own name, without its extension —
   * `runs/<runId>.jsonl` → `runs/<runId>/`. A reader resolves `attachment: "12"` by looking for
   * `12.*` in there and nothing else: no manifest, no index, so a run that ends mid-write still
   * leaves every already-written attachment readable (spec/core/trace.md §Attachments).
   */
  get attachmentsDir(): string | undefined {
    const path = this.#path;
    return path === undefined ? undefined : join(dirname(path), basename(path, extname(path)));
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

  /**
   * Bytes for an attachment the next `step` event references by id. Same contract as `emit`:
   * buffer, swallow, count — implementing this method is what makes the engine capture
   * screenshots for the trace at all.
   */
  attach(attachment: TraceAttachment): void {
    try {
      this.#pendingAttachments.push(attachment);
      this.#schedule();
    } catch {
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
    if (!path) return;
    // Bytes before the lines that reference them: a flush cut short leaves an unreferenced
    // sidecar (harmless) rather than a reference resolving to nothing.
    await this.#flushAttachments(path);
    if (!this.#pending.length) return;
    const chunk = `${this.#pending.splice(0).join("\n")}\n`;
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, chunk, "utf8");
  }

  /** One file per attachment, written as it arrives — never a manifest at close. */
  async #flushAttachments(path: string): Promise<void> {
    if (!this.#pendingAttachments.length) return;
    const dir = join(dirname(path), basename(path, extname(path)));
    for (const attachment of this.#pendingAttachments.splice(0)) {
      try {
        const decoded = decodeDataUrl(attachment.data);
        if (!decoded) throw new Error(`attachment ${attachment.id} is not a data URL`);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${attachment.id}.${extensionFor(decoded.mediaType)}`), decoded.bytes);
      } catch {
        // One unwritable frame must not cost the trace its remaining events.
        this.#failures += 1;
      }
    }
  }
}
