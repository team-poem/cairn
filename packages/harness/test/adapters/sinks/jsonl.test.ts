import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonlTraceSink } from "../../../src/adapters/sinks/jsonl.js";
import type { TraceSink } from "../../../src/core/ports.js";
import { ENGINE_VERSION } from "../../../src/version.js";
import { startTrace } from "../../../src/core/trace.js";
import type { TraceEvent } from "../../../src/core/trace.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-sink-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const inDir = (name: string) => (runId: string) => join(dir, name, `${runId}.jsonl`);

const readLines = async (path: string): Promise<TraceEvent[]> =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TraceEvent);

describe("JsonlTraceSink (TraceSink port)", () => {
  it("takes its identity and its path from the header the engine emits", async () => {
    const sink = new JsonlTraceSink(inDir("identity"));
    const tracer = startTrace(sink, ENGINE_VERSION);

    // `startTrace` emits the header synchronously — that is what names the file, so the run has
    // one identity rather than a file name and a header that can disagree.
    expect(sink.runId).toBeDefined();
    expect(sink.path).toBe(join(dir, "identity", `${sink.runId}.jsonl`));

    tracer.emit({ kind: "run-end", payload: { passed: true } });
    await sink.close();

    const events = await readLines(sink.path!);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      seq: 0,
      kind: "trace",
      payload: { runId: sink.runId, engine: { name: "cairn", version: ENGINE_VERSION } },
    });
    expect(events[1]).toMatchObject({ seq: 1, kind: "run-end" });
    expect(sink.failures).toBe(0);
  });

  it("appends in seq order behind the sync emit, and retains the same events in memory", async () => {
    const sink = new JsonlTraceSink(inDir("ordered"));
    const tracer = startTrace(sink, ENGINE_VERSION);
    const scope = tracer.scope("cart");
    scope.emit({ kind: "case-start", payload: { id: "cart", intent: "open the cart", cached: true } });
    for (let i = 0; i < 50; i += 1) {
      scope.emit({
        kind: "step",
        phase: "replay",
        stepRef: i,
        payload: { step: { kind: "pressKey", key: "Enter" }, ok: true },
      });
    }
    scope.emit({
      kind: "case-end",
      payload: { verdict: { passed: true, results: [] }, discovered: false, heals: 0 },
    });
    tracer.emit({ kind: "run-end", payload: { passed: true } });
    await sink.close();

    const written = await readLines(sink.path!);
    expect(written.map((e) => e.seq)).toEqual(sink.events.map((e) => e.seq));
    expect(written.map((e) => e.seq)).toEqual([...written.keys()]);
    expect(written).toEqual(sink.events);
  });

  it("keeps events buffered until a header gives them a home", async () => {
    const sink = new JsonlTraceSink(inDir("late-header"));
    const orphan: TraceEvent = { seq: 0, ts: 1, kind: "run-end", payload: { passed: true } };

    sink.emit(orphan);
    await sink.close();
    expect(sink.path).toBeUndefined();
    expect(sink.failures).toBe(0);

    // Nothing was lost while there was no path: the header arrives, and the held event lands with it.
    const tracer = startTrace(sink, ENGINE_VERSION);
    tracer.emit({ kind: "run-end", payload: { passed: true } });
    await sink.close();

    const written = await readLines(sink.path!);
    expect(written.map((e) => e.kind)).toEqual(["run-end", "trace", "run-end"]);
  });

  it("never throws out of emit when the path cannot be resolved, and counts it", async () => {
    const sink: TraceSink = new JsonlTraceSink(() => {
      throw new Error("no path for you");
    });
    const header: TraceEvent = {
      seq: 0,
      ts: 0,
      kind: "trace",
      payload: { version: "1.0", runId: "x", engine: { name: "cairn", version: ENGINE_VERSION } },
    };

    expect(() => sink.emit(header)).not.toThrow();
    await (sink as JsonlTraceSink).close();
    expect((sink as JsonlTraceSink).failures).toBeGreaterThan(0);
  });

  it("files attachment bytes as sidecars a reader resolves by name alone (#160)", async () => {
    const sink = new JsonlTraceSink(inDir("shots"));
    const tracer = startTrace(sink, ENGINE_VERSION);
    const png = Buffer.from("fake-png-bytes");
    tracer.emit(
      { kind: "step", phase: "replay", stepRef: 0, payload: { step: { kind: "pressKey", key: "Enter" }, ok: true } },
      `data:image/png;base64,${png.toString("base64")}`,
    );
    await sink.close();

    // Layout is the trace file's own name, minus the extension — `<runId>.jsonl` → `<runId>/`.
    expect(sink.attachmentsDir).toBe(join(dir, "shots", sink.runId!));
    const [, step] = await readLines(sink.path!);
    if (step?.kind !== "step") throw new Error("unreachable");
    expect(step.payload.attachment).toBe("1");

    // Resolved by convention: the id plus a media-type extension. No manifest is consulted, and
    // none exists — the directory listing is the index.
    const files = await readdir(sink.attachmentsDir!);
    expect(files).toEqual(["1.png"]);
    expect(await readFile(join(sink.attachmentsDir!, "1.png"))).toEqual(png);
  });

  it("leaves every already-written attachment readable when a run is cut short", async () => {
    // A trace that ends mid-run is normal (crash, Stop). Nothing may depend on a close that never
    // came — so bytes land as they arrive, and the surviving prefix stands on its own.
    const sink = new JsonlTraceSink(inDir("truncated"));
    const tracer = startTrace(sink, ENGINE_VERSION);
    const shot = (n: number) =>
      tracer.emit(
        { kind: "step", phase: "replay", stepRef: n, payload: { step: { kind: "pressKey", key: "Enter" }, ok: true } },
        `data:image/png;base64,${Buffer.from(`frame-${n}`).toString("base64")}`,
      );

    shot(0);
    await sink.close(); // stands in for "the process got this far"
    shot(1); // …and this one never flushed: the run died here

    expect(await readdir(sink.attachmentsDir!)).toEqual(["1.png"]);
    expect(await readFile(join(sink.attachmentsDir!, "1.png"), "utf8")).toBe("frame-0");
  });

  it("counts an attachment it cannot decode without touching the events around it", async () => {
    const sink = new JsonlTraceSink(inDir("bad-bytes"));
    const tracer = startTrace(sink, ENGINE_VERSION);
    tracer.emit(
      { kind: "step", phase: "replay", stepRef: 0, payload: { step: { kind: "pressKey", key: "Enter" }, ok: true } },
      "not-a-data-url",
    );
    tracer.emit({ kind: "run-end", payload: { passed: true } });
    await sink.close();

    expect(sink.failures).toBe(1);
    // The trace itself is intact — including the (now dangling) ref, which is the honest record:
    // the engine did capture a frame, and `failures` is what says it never landed.
    const events = await readLines(sink.path!);
    expect(events.map((e) => e.kind)).toEqual(["trace", "step", "run-end"]);
    await expect(readdir(sink.attachmentsDir!)).rejects.toThrow();
  });

  it("counts a write it could not make rather than failing the run", async () => {
    // A file where the trace's directory should be: mkdir fails, so every flush fails.
    const blocked = join(dir, "blocked");
    await writeFile(blocked, "not a directory", "utf8");

    const sink = new JsonlTraceSink((runId) => join(blocked, `${runId}.jsonl`));
    const tracer = startTrace(sink, ENGINE_VERSION);
    tracer.emit({ kind: "run-end", payload: { passed: true } });
    await sink.close();

    // The run saw nothing: no throw escaped either emit. The trace says it is incomplete.
    expect(sink.failures).toBeGreaterThan(0);
    expect(sink.events).toHaveLength(2);
  });

  it("jsonlSinkSvgAttachmentGetsSvgExtension: an image/svg+xml attachment is filed as <id>.svg, not .xml", async () => {
    const sink = new JsonlTraceSink(inDir("svg"));
    const tracer = startTrace(sink, ENGINE_VERSION);
    sink.attach({ id: "1", data: "data:image/svg+xml;base64,PHN2Zy8+" });
    tracer.emit({ kind: "run-end", payload: { passed: true } });
    await sink.close();

    expect(sink.failures).toBe(0);
    expect(await readdir(sink.attachmentsDir!)).toEqual(["1.svg"]);
  });
});

describe("JsonlTraceSink extension fallback audit coverage", () => {
  async function sidecarsFor(name: string, data: string): Promise<string[]> {
    const sink = new JsonlTraceSink((runId) => join(dir, name, `${runId}.jsonl`));
    const tracer = startTrace(sink, ENGINE_VERSION);
    sink.attach({ id: "1", data });
    tracer.emit({ kind: "run-end", payload: { passed: true } });
    await sink.close();
    expect(sink.failures).toBe(0);
    return readdir(sink.attachmentsDir!);
  }

  it("jsonlSinkSanitizesUnknownSubtype: an unmapped but well-formed type uses its subtype, lower-cased and stripped of punctuation", async () => {
    expect(await sidecarsFor("sub", "data:application/x-Foo.Bar;base64,AAAA")).toEqual(["1.xfoobar"]);
  });

  it("jsonlSinkUnmappedTypeFallsBackToBin: a media type with no usable subtype is filed as <id>.bin; a known type keeps its table extension", async () => {
    expect(await sidecarsFor("bin", "data:binary;base64,AAAA")).toEqual(["1.bin"]);
    expect(await sidecarsFor("jpg", "data:image/jpeg;base64,AAAA")).toEqual(["1.jpg"]);
    expect(await sidecarsFor("noType", "data:,hello")).toEqual(["1.txt"]);
  });
});
