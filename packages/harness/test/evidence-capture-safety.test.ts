import { afterEach, describe, expect, it, vi } from "vitest";
import { runScenario } from "../src/run.js";
import { checkpointEvidence, EvidenceCaptureSession, sameCapturePath } from "../src/core/evidence-capture.js";
import type { Step } from "../src/core/types.js";
import { StubDriver } from "./support/doubles.js";

const reporter = { async emit() {} };
const edit: Step = { kind: "click", target: { text: "Edit" } };
const point = { id: "editor", after: [edit], elements: true };
const required = async (_params: Record<string, unknown>, evidence: Parameters<typeof checkpointEvidence>[0]) =>
  await checkpointEvidence(evidence, point) ? true
    : { inconclusive: true as const, required: true as const, detail: "Checkpoint unavailable" };

function customStep(value: unknown): Step {
  return { kind: "custom", name: "mutate", params: { value } };
}

const unsupported = [
  ["Date", () => new Date("2026-01-01T00:00:00.000Z")],
  ["Map", () => new Map([["key", "value"]])],
  ["NaN", () => Number.NaN],
  ["undefined array entry", () => [undefined]],
  ["sparse array", () => new Array(1)],
  ["cycle", () => { const value: Record<string, unknown> = {}; value.self = value; return value; }],
  ["function", () => () => "not JSON"],
  ["symbol", () => Symbol("not JSON")],
  ["BigInt", () => 1n],
  ["negative zero", () => -0],
] satisfies Array<[string, () => unknown]>;

afterEach(() => vi.restoreAllMocks());

describe("checkpoint redaction and binding safety", () => {
  it.each(["editor", "replay", "captured", "after-step", "driver-snapshot", "unknown", "click", "button", "1"])(
    "does not redact engine metadata when a supplied secret equals %s", async secret => {
      vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
      const driver = new StubDriver();
      driver.els = [{ role: "button", name: "Review", disabled: false }];
      const { result } = await runScenario({ name: "redaction", steps: [edit], assertions: [
        { kind: "custom", name: "required" }, { kind: "no-console-errors" },
      ] }, { driver, reporter, secrets: { credential: secret }, custom: { required },
        evidenceCapture: { checkpoints: [point] } });
      expect(result.verdict.passed).toBe(true);
      const record = result.evidence.checkpoints![0]!;
      expect(record).toMatchObject({ id: "editor", phase: "replay", status: "captured", boundary: "after-step",
        coverage: "driver-snapshot", documentIdentity: "unknown", runId: result.evidence.captureRunId,
        actionId: `${result.evidence.captureRunId}:0`, action: { step: { kind: "click" } },
        elements: [{ role: "button" }],
      });
      expect(await checkpointEvidence(result.evidence, point)).toBe(record);
    });

  it("binds using the original action data even when displayed action fields are redacted", async () => {
    const step: Step = { kind: "click", target: { text: "private-name" } };
    const selection = { id: "private-name", after: [step], elements: true };
    const { result } = await runScenario({ name: "redacted action", steps: [step], assertions: [{ kind: "no-console-errors" }] }, {
      driver: new StubDriver(), reporter, secrets: { account: "private-name" }, evidenceCapture: { checkpoints: [selection] },
    });
    const record = await checkpointEvidence(result.evidence, selection);
    expect(record).toMatchObject({ id: "private-name", status: "captured",
      action: { step: { target: { text: "{account}" } } }, path: [{ target: { text: "{account}" } }],
    });
    expect(await checkpointEvidence(result.evidence, { ...selection,
      after: [{ kind: "click", target: { text: "{account}" } }] })).toBeUndefined();
  });

  it("preserves measured mixed checkbox state and scroll direction when they match secrets", async () => {
    const driver = new StubDriver();
    driver.els = [{ role: "checkbox", name: "Selection", checked: "mixed" }];
    const step: Step = { kind: "scroll", direction: "down" };
    const selection = { id: "after-scroll", after: [step], elements: true };
    const { result } = await runScenario({ name: "schema enums", steps: [step], assertions: [{ kind: "custom", name: "mixed" }] }, {
      driver, reporter, secrets: { state: "mixed", direction: "down" }, evidenceCapture: { checkpoints: [selection] },
      custom: { mixed: async (_params, evidence) => {
        const record = await checkpointEvidence(evidence, selection);
        return record?.elements?.[0]?.checked === "mixed";
      } },
    });
    expect(result.verdict.passed).toBe(true);
    expect(result.evidence.checkpoints?.[0]).toMatchObject({ action: { step: { kind: "scroll", direction: "down" } },
      elements: [{ role: "checkbox", checked: "mixed" }], path: [{ kind: "scroll", direction: "down" }],
    });
  });

  it("preserves collection schema enums while redacting free-text names and values", async () => {
    const step: Step = { kind: "click", target: { collection: {
      root: { role: "list", name: "private-name" }, itemRole: "listitem", target: { role: "button", name: "private-name" },
      order: "dom", index: 0, conditions: [{ control: { role: "checkbox", name: "private-name" }, checked: "mixed" }],
    } } };
    const session = new EvidenceCaptureSession({ checkpoints: [{ id: "collection", after: [step], elements: true }] }, "replay", {
      item: "listitem", order: "dom", state: "mixed", account: "private-name",
    });
    await session.after({ step, ok: true }, new StubDriver());
    expect(session.finish()[0]?.action?.step).toMatchObject({ target: { collection: {
      root: { name: "{account}" }, itemRole: "listitem", order: "dom",
      target: { name: "{account}" }, conditions: [{ checked: "mixed", control: { name: "{account}" } }],
    } } });
  });

  it("redacts nested screenshot-named data without redacting actual screenshot bytes", async () => {
    const step: Step = { kind: "custom", name: "mutate", params: {
      screenshot: "private-value", nested: [{ screenshot: "private-value" }], ordinary: "private-value",
    } };
    const driver = new StubDriver();
    driver.screenshot = async () => "pixels:private-value";
    const { result } = await runScenario({ name: "nested fields", steps: [step], assertions: [{ kind: "no-console-errors" }] }, {
      driver, reporter, secrets: { password: "private-value" }, actions: { mutate: async () => {} },
      evidenceCapture: { checkpoints: [{ id: "point", after: [step], elements: true, screenshot: true }] },
    });
    const record = result.evidence.checkpoints![0]!;
    const redacted = { screenshot: "{password}", nested: [{ screenshot: "{password}" }], ordinary: "{password}" };
    expect(record.action?.step).toMatchObject({ params: redacted });
    expect(record.path[0]).toMatchObject({ params: redacted });
    expect(record.screenshot).toBe("pixels:private-value");
    expect(await checkpointEvidence(result.evidence, { id: "point", after: [step] })).toBe(record);
  });

  it.each(unsupported)("rejects declared %s data before any mutation", async (_name, makeValue) => {
    const driver = new StubDriver();
    await expect(runScenario({ name: "invalid selection", steps: [edit], assertions: [{ kind: "no-console-errors" }] }, {
      driver, reporter, evidenceCapture: { checkpoints: [{ id: "invalid", after: [customStep(makeValue())], elements: true }] },
    })).rejects.toThrow(/evidence capture/);
    expect(driver.clicked).toEqual([]);
  });

  it.each(unsupported)("never treats unsupported %s data as an equal JSON path", async (_name, makeValue) => {
    const unsupportedPath = [customStep(makeValue())];
    expect(sameCapturePath(unsupportedPath, [customStep({})])).toBe(false);
    expect(sameCapturePath(unsupportedPath, [customStep(null)])).toBe(false);
    expect(sameCapturePath(unsupportedPath, unsupportedPath)).toBe(false);
    const driver = new StubDriver();
    const validPath = [customStep({})];
    const session = new EvidenceCaptureSession({ checkpoints: [{ id: "valid", after: validPath, elements: true }] }, "replay");
    await session.after({ step: validPath[0]!, ok: true }, driver);
    const evidence = { ...await driver.observe(), checkpoints: session.finish(), captureRunId: session.runId };
    expect(await checkpointEvidence(evidence, { id: "valid", after: unsupportedPath })).toBeUndefined();
    expect(await checkpointEvidence(evidence, { id: "valid", after: validPath })).toBeDefined();
  });

  it.each(unsupported)("cannot throw after an executed mutation whose runtime params contain %s", async (_name, makeValue) => {
    const mutation = vi.fn(async () => {});
    const driver = new StubDriver();
    const snapshot = vi.spyOn(driver, "snapshot");
    const { result } = await runScenario({ name: "runtime unsupported data", steps: [customStep(makeValue()), edit],
      assertions: [{ kind: "no-console-errors" }] }, {
      driver, reporter, actions: { mutate: mutation },
      evidenceCapture: { checkpoints: [{ id: "diagnostic", after: [customStep({})], elements: true }] },
    });
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(driver.clicked).toEqual(["Edit"]);
    expect(snapshot).not.toHaveBeenCalled();
    expect(result.verdict.passed).toBe(true);
    expect(result.evidence.checkpoints?.[0]).toMatchObject({ status: "unavailable", complete: false, reason: "unsupported-path" });
  });

  it.each(unsupported)("does not inspect later %s parameters after all selections complete", async (_name, makeValue) => {
    const mutation = vi.fn(async () => {});
    const { result } = await runScenario({ name: "completed capture", steps: [edit, customStep(makeValue())],
      assertions: [{ kind: "custom", name: "required" }] }, {
      driver: new StubDriver(), reporter, actions: { mutate: mutation }, custom: { required },
      evidenceCapture: { checkpoints: [point] },
    });
    expect(result.verdict.passed).toBe(true);
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(result.evidence.checkpoints).toHaveLength(1);
    expect(result.evidence.checkpoints?.[0]?.path).toEqual([edit]);
  });

  it("rejects accessor params without invoking a getter while recording completed work", async () => {
    const getter = vi.fn(() => { throw new Error("must not be called"); });
    const value = Object.defineProperty({}, "private", { enumerable: true, get: getter });
    const session = new EvidenceCaptureSession({ checkpoints: [{ id: "pending", after: [customStep({})], elements: true }] }, "replay");
    await expect(session.after({ step: customStep(value), ok: true }, new StubDriver())).resolves.toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    expect(session.finish()[0]).toMatchObject({ status: "unavailable", reason: "unsupported-path" });
  });
});
