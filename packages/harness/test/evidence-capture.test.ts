import { afterEach, describe, expect, it, vi } from "vitest";
import { runScenario } from "../src/run.js";
import { discover } from "../src/core/discover/index.js";
import { runHarness } from "../src/core/pipeline.js";
import { AssertionCritic } from "../src/adapters/critics/assertion.js";
import { StaticPlanner } from "../src/adapters/planners/static.js";
import { InlineContextProvider } from "../src/adapters/context/inline.js";
import { checkpointEvidence, EvidenceCaptureSession } from "../src/core/evidence-capture.js";
import { assertionPayload } from "../src/core/trace.js";
import { runWorkflow } from "../src/core/budget.js";
import type { EvidenceCaptureOptions, EvidenceCheckpointRecord } from "../src/core/evidence-capture.js";
import type { Evidence, PageElement, Scenario, Step, Target } from "../src/core/types.js";
import { ScriptedLlm, StubDriver } from "./support/doubles.js";

const editor: Step = { kind: "click", target: { text: "Edit" } };
const review: Step = { kind: "click", target: { text: "Review" } };
const confirm: Step = { kind: "click", target: { text: "Confirm" } };
const point = { id: "editor", after: [editor], elements: true };
const reporter = { emit: async () => {} };
const capture: EvidenceCaptureOptions = { checkpoints: [point] };
const scenario: Scenario = {
  name: "editor-review-confirmation", steps: [editor, review, confirm], assertions: [
    { kind: "custom", name: "editor", params: { after: [editor] } },
    { kind: "navigated", to: "https://app/confirmation" },
  ],
};
const custom = { editor: async (params: Record<string, unknown>, evidence: Evidence) => {
  const record = await checkpointEvidence(evidence, { id: "editor", after: params.after as Step[] });
  if (!record?.elements) return { inconclusive: true as const, required: true as const, detail: "editor checkpoint unavailable" };
  return { passed: record.elements.some(e => e.role === "heading" && e.name === "Editor")
    && record.elements.some(e => e.role === "button" && e.name === "Review" && e.disabled === false) };
} };

class EditorDriver extends StubDriver {
  heading = "Editor";
  disabled = false;
  shots = 0;
  override async click(target: Target): Promise<void> {
    await super.click(target);
    this.url = `https://app/${target.text === "Edit" ? "editor" : target.text === "Review" ? "review" : "confirmation"}`;
  }
  override async snapshot(): Promise<PageElement[]> {
    return this.url.endsWith("/editor") ? [
      { role: "heading", name: this.heading }, { role: "button", name: "Review", disabled: this.disabled },
    ] : [{ role: "heading", name: "Confirmation" }];
  }
  override async screenshot(): Promise<string> { this.shots++; return `image:${this.url}`; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("awaited evidence checkpoints", () => {
  it.each([["Editor", false, true], ["Wrong editor", false, false], ["Editor", true, false]] as const)(
    "judges intermediate state (%s, disabled=%s), separately from final success", async (heading, disabled, passed) => {
      const driver = new EditorDriver(); driver.heading = heading; driver.disabled = disabled;
      const llm = { id: "never", complete: vi.fn(async () => { throw new Error("replay must not call a model"); }) };
      const { result } = await runScenario(scenario, { driver, reporter, custom, evidenceCapture: capture, llm, judgmentKey: "editor-v1" });
      expect(result.verdict.passed).toBe(passed);
      expect(result.verdict.results[1]?.passed).toBe(true);
      expect(result.evidence.checkpoints?.[0]).toMatchObject({ status: "captured", complete: true, phase: "replay",
        boundary: "after-step", index: 0, action: { step: editor, ok: true } });
      expect(result.usage?.llmCalls).toBe(0);
      expect(llm.complete).not.toHaveBeenCalled();
    });

  it("does not dispatch the second mutation while the first boundary read is pending", async () => {
    const driver = new EditorDriver();
    const entered = deferred<void>(); const read = deferred<PageElement[]>();
    driver.snapshot = async () => { entered.resolve(); return read.promise; };
    const running = runScenario(scenario, { driver, reporter, custom, evidenceCapture: capture });
    await entered.promise;
    expect(driver.clicked).toEqual(["Edit"]);
    read.resolve([{ role: "heading", name: "Editor" }, { role: "button", name: "Review", disabled: false }]);
    expect((await running).result.verdict.passed).toBe(true);
    expect(driver.clicked).toEqual(["Edit", "Review", "Confirm"]);
  });

  it("drains a timed-out read, rejects its late data, and never retries a mutation", async () => {
    let time = 0; vi.spyOn(performance, "now").mockImplementation(() => time);
    const driver = new EditorDriver(); const entered = deferred<void>(); const read = deferred<PageElement[]>();
    driver.snapshot = async () => { entered.resolve(); return read.promise; };
    const running = runScenario(scenario, { driver, reporter, custom, evidenceCapture: { ...capture, timeoutMs: 10 } });
    await entered.promise; time = 11;
    expect(driver.clicked).toEqual(["Edit"]);
    read.resolve([{ role: "heading", name: "Editor" }]);
    const { result } = await running;
    expect(result.evidence.checkpoints?.[0]).toMatchObject({ status: "timed-out", complete: false, elapsedMs: 11 });
    expect(result.evidence.checkpoints?.[0]?.elements).toBeUndefined();
    expect(result.verdict).toMatchObject({ passed: false, failure: "environment" });
    expect(result.verdict.results[0]).toMatchObject({ reason: "inconclusive", required: true });
    expect(driver.clicked).toEqual(["Edit", "Review", "Confirm"]);
  });

  it("cancellation drains capture and prevents the next action; notification retains cancellation", async () => {
    const driver = new EditorDriver(); const entered = deferred<void>(); const read = deferred<PageElement[]>();
    const controller = new AbortController(); const records: EvidenceCheckpointRecord[] = [];
    driver.snapshot = async () => { entered.resolve(); return read.promise; };
    const running = runScenario(scenario, { driver, reporter, custom, signal: controller.signal,
      evidenceCapture: { ...capture, onCapture: r => records.push(r) } });
    const rejected = expect(running).rejects.toThrow("stop");
    await entered.promise; controller.abort(new Error("stop"));
    expect(records).toHaveLength(0);
    read.resolve([]); await rejected;
    expect(records[0]).toMatchObject({ status: "cancelled", complete: false });
    expect(driver.clicked).toEqual(["Edit"]);
  });

  it("capture failure is not an application failure and cannot retry mutation", async () => {
    const driver = new EditorDriver(); driver.snapshot = async () => { throw new Error("private driver text"); };
    const { result } = await runScenario(scenario, { driver, reporter, custom, evidenceCapture: capture });
    expect(result.evidence.checkpoints?.[0]).toMatchObject({ status: "unavailable", reason: "capture-failed" });
    expect(JSON.stringify(result.evidence.checkpoints)).not.toContain("private driver text");
    expect(result.verdict.passed).toBe(false);
    expect(driver.clicked).toEqual(["Edit", "Review", "Confirm"]);
  });

  it("capture disabled does no extra reads and cannot satisfy a required checkpoint", async () => {
    const driver = new EditorDriver(); const snapshot = vi.spyOn(driver, "snapshot");
    const { result } = await runScenario(scenario, { driver, reporter, custom });
    expect(snapshot).not.toHaveBeenCalled();
    expect(result.evidence.checkpoints).toBeUndefined();
    expect(result.verdict.passed).toBe(false);
    expect(result.verdict.results[1]?.passed).toBe(true);
  });

  it("optional inconclusive checks keep their existing behavior", async () => {
    const { result } = await runScenario(scenario, { driver: new EditorDriver(), reporter,
      custom: { editor: () => ({ inconclusive: true, detail: "optional" }) } });
    expect(result.verdict.passed).toBe(true);
  });

  it("shares screenshots at the same boundary with legacy progress and duplicate selections", async () => {
    const driver = new EditorDriver(); const progress: string[] = [];
    const { result } = await runScenario(scenario, { driver, reporter, custom, screenshots: true,
      onStep: p => { if (p.screenshot) progress.push(p.screenshot); }, evidenceCapture: { checkpoints: [
        { ...point, screenshot: true }, { ...point, id: "same-boundary", screenshot: true },
      ] } });
    expect(driver.shots).toBe(3);
    expect(result.evidence.checkpoints?.map(r => r.screenshot)).toEqual([progress[0], progress[0]]);
  });

  it("snapshots policy at entry and isolates notification mutations", async () => {
    const driver = new EditorDriver(); const entered = deferred<void>(); const read = deferred<PageElement[]>();
    const options = structuredClone(capture);
    options.onCapture = record => { record.status = "skipped"; record.path.length = 0; };
    driver.snapshot = async () => { entered.resolve(); return read.promise; };
    const running = runScenario(scenario, { driver, reporter, custom, evidenceCapture: options });
    await entered.promise; (options.checkpoints[0]!.after as Step[]).length = 0;
    read.resolve([{ role: "heading", name: "Editor" }, { role: "button", name: "Review", disabled: false }]);
    expect((await running).result.verdict.passed).toBe(true);
  });

  it("records skip, failure and unreached boundaries without treating them as evidence", async () => {
    const driver = new EditorDriver();
    const skipped = { ...editor, expect: { url: "https://app/start" } };
    const { result } = await runScenario({ ...scenario, steps: [skipped, review, confirm] },
      { driver, reporter, custom, evidenceCapture: capture });
    expect(result.evidence.checkpoints?.[0]).toMatchObject({ reason: "step-skipped", complete: false });
    expect(result.verdict.passed).toBe(false);
    const broken = new EditorDriver(); broken.click = async () => { throw new Error("no control"); };
    const failure = await runScenario(scenario, { driver: broken, reporter, custom, evidenceCapture: { checkpoints: [point,
      { id: "review", after: [editor, review], elements: true }] } });
    expect(failure.result.evidence.checkpoints?.map(r => r.reason)).toEqual(["step-failed", "not-reached"]);
  });

  it("removed/edited prefixes do not rebind by numeric index; previous runs cannot fill the gap", async () => {
    const first = await runScenario(scenario, { driver: new EditorDriver(), reporter, custom, evidenceCapture: capture });
    const second = await runScenario({ ...scenario, steps: [review, confirm] },
      { driver: new EditorDriver(), reporter, custom, evidenceCapture: capture });
    expect(second.result.verdict.passed).toBe(false);
    expect(second.result.evidence.checkpoints?.[0]?.reason).toBe("path-changed");
    const stale = { ...second.result.evidence, checkpoints: first.result.evidence.checkpoints };
    expect(await checkpointEvidence(stale, point)).toBeUndefined();
  });

  it("repeated actions have distinct occurrence IDs and paths", async () => {
    const driver = new EditorDriver();
    const session = new EvidenceCaptureSession({ checkpoints: [point,
      { ...point, id: "again", after: [editor, editor] }] }, "replay");
    await session.after({ step: editor, ok: true }, driver);
    await session.after({ step: editor, ok: true }, driver);
    const records = session.finish();
    expect(new Set(records.map(r => r.actionId)).size).toBe(2);
    expect(records.map(r => r.path.length)).toEqual([1, 2]);
  });

  it("uses the actual healed replacement and requires an explicit rebound capture path", async () => {
    const driver = new EditorDriver();
    const original = { ...editor, expect: { url: "https://app/review" } };
    const result = await runHarness({ driver, reporter, planner: new StaticPlanner({ ...scenario, steps: [original] }),
      context: new InlineContextProvider(), critic: new AssertionCritic() }, "heal", {
      expectTimeoutMs: 0, stepHealer: { heal: async () => { await driver.click(review.target!); return { step: review, index: 0 }; } },
      evidenceCapture: { checkpoints: [point, { ...point, id: "rebound", after: [review] }] },
    });
    expect(result.evidence.checkpoints?.[0]?.reason).toBe("path-changed");
    expect(result.evidence.checkpoints?.[1]).toMatchObject({ status: "captured", action: { step: review } });
  });

  it("excludes values/refs by default and slots supplied secrets without pretending to sanitize pixels", async () => {
    const driver = new EditorDriver();
    driver.snapshot = async () => [{ role: "textbox", name: "secret-value", value: "secret-value", ref: "private-ref" }];
    driver.screenshot = async () => "pixels:secret-value";
    const session = new EvidenceCaptureSession({ checkpoints: [{ ...point, screenshot: true }] }, "replay", { password: "secret-value" });
    await session.after({ step: editor, ok: true }, driver);
    expect(session.records[0]?.elements).toEqual([{ role: "textbox", name: "{password}" }]);
    expect(session.records[0]?.screenshot).toBe("pixels:secret-value");
  });

  it("supports discovery notification and fresh zero-model replay without freezing capture settings", async () => {
    const records: EvidenceCheckpointRecord[] = [];
    const driver = new EditorDriver();
    const snapshot = driver.snapshot.bind(driver);
    driver.snapshot = async () => [...await snapshot(), { role: "button", name: "Edit" }, { role: "button", name: "Confirm" }];
    const frozen = await discover("edit then confirm", { driver, llm: new ScriptedLlm([
      '{"action":"click","text":"Edit"}', '{"action":"click","text":"Review"}',
      '{"action":"click","text":"Confirm"}', '{"action":"done"}',
    ]), evidenceCapture: { checkpoints: [{ ...point, phase: "discover" }], onCapture: r => records.push(r) } });
    expect(records[0]).toMatchObject({ status: "captured", phase: "discover", action: { step: editor } });
    expect(JSON.stringify(frozen)).not.toContain("checkpoints");
    const replay = await runScenario({ ...frozen, assertions: scenario.assertions }, {
      driver: new EditorDriver(), reporter, custom, evidenceCapture: capture,
    });
    expect(replay.result.evidence.captureRunId).not.toBe(records[0]?.runId);
    expect(replay.result.usage?.llmCalls).toBe(0);
  });

  it("keeps capture policy outside judgment identity while required semantics remain in custom assertions", async () => {
    const first = await runScenario(scenario, { driver: new EditorDriver(), reporter, custom, judgmentKey: "editor-v1", evidenceCapture: capture });
    const second = await runScenario(scenario, { driver: new EditorDriver(), reporter, custom, judgmentKey: "editor-v1" });
    expect(first.result.verdict.contract?.fingerprint).toBe(second.result.verdict.contract?.fingerprint);
    expect(assertionPayload(second.result.verdict.results[0]!)).toMatchObject({ reason: "inconclusive", required: true });
  });

  it("counts capture time against the run budget and never advances after exhaustion", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let time = 0; vi.spyOn(performance, "now").mockImplementation(() => time);
    const driver = new EditorDriver(); const entered = deferred<void>(); const read = deferred<PageElement[]>();
    driver.snapshot = async () => { entered.resolve(); return read.promise; };
    const running = runScenario(scenario, { driver, reporter, custom, evidenceCapture: capture, budget: { timeoutMs: 10 } });
    await entered.promise; time = 11; read.resolve([]);
    const { result } = await running;
    expect(result.verdict).toMatchObject({ passed: false, failure: "budget" });
    expect(driver.clicked).toEqual(["Edit"]);
  });

  it("rejects incomplete requested data even when the available DOM would pass", async () => {
    const driver = new EditorDriver(); driver.screenshot = async () => undefined as unknown as string;
    const { result } = await runScenario(scenario, { driver, reporter, custom,
      evidenceCapture: { checkpoints: [{ ...point, screenshot: true }] } });
    expect(result.evidence.checkpoints?.[0]).toMatchObject({ status: "unavailable", complete: false });
    expect(result.evidence.checkpoints?.[0]?.elements).toBeUndefined();
    expect(result.verdict.passed).toBe(false);
  });

  it("invalidates later captures when an earlier action was skipped", async () => {
    const session = new EvidenceCaptureSession({ checkpoints: [{ ...point, after: [editor, review] }] }, "replay");
    const driver = new EditorDriver();
    await session.after({ step: editor, ok: true, skipped: true }, driver);
    await session.after({ step: review, ok: true }, driver);
    expect(session.records[0]).toMatchObject({ status: "skipped", reason: "step-skipped" });
  });

  it("isolates healing-phase captures and rejects ambiguous checkpoint records", async () => {
    const session = new EvidenceCaptureSession({ checkpoints: [{ ...point, phase: "heal" }] }, "heal");
    const driver = new EditorDriver();
    await session.after({ step: editor, ok: true }, driver);
    const evidence = { ...await driver.observe(), checkpoints: session.finish(), captureRunId: session.runId };
    expect(await checkpointEvidence(evidence, point)).toBeUndefined();
    expect((await checkpointEvidence(evidence, { ...point, phase: "heal" }))?.phase).toBe("heal");
    evidence.checkpoints.push(evidence.checkpoints[0]!);
    expect(await checkpointEvidence(evidence, { ...point, phase: "heal" })).toBeUndefined();
  });

  it("borrows capture time from the workflow owner without advancing after exhaustion", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let time = 0; vi.spyOn(performance, "now").mockImplementation(() => time);
    const driver = new EditorDriver(); const entered = deferred<void>(); const read = deferred<PageElement[]>();
    driver.snapshot = async () => { entered.resolve(); return read.promise; };
    const running = runWorkflow({ budget: { timeoutMs: 10 } }, async workflow =>
      runScenario(scenario, { driver, reporter, custom, evidenceCapture: capture, workflow: workflow.borrow("editor") }));
    await entered.promise; time = 11; read.resolve([]);
    expect((await running).status).toBe("exhausted");
    expect(driver.clicked).toEqual(["Edit"]);
  });

  it("observer exceptions and rejected promises cannot retry or fail a captured action", async () => {
    for (const onCapture of [() => { throw new Error("observer"); }, () => Promise.reject(new Error("observer"))]) {
      const driver = new EditorDriver();
      const { result } = await runScenario(scenario, { driver, reporter, custom, evidenceCapture: { ...capture, onCapture } });
      expect(result.verdict.passed).toBe(true);
      expect(driver.clicked).toEqual(["Edit", "Review", "Confirm"]);
    }
  });

  it("rejects invalid capture configuration before dispatch", async () => {
    const driver = new EditorDriver();
    await expect(runScenario(scenario, { driver, reporter, custom,
      evidenceCapture: { checkpoints: [point, point] } })).rejects.toThrow("unique IDs");
    expect(driver.clicked).toEqual([]);
  });
});
