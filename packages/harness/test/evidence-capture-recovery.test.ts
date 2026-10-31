import { describe, expect, it, vi } from "vitest";
import { runScenario } from "../src/run.js";
import { checkpointEvidence } from "../src/core/evidence-capture.js";
import type { EvidenceCheckpointRecord } from "../src/core/evidence-capture.js";
import { compareContracts, hashContractValue, scenarioContract } from "../src/core/contract.js";
import type { Evidence, PageElement, Scenario, Step } from "../src/core/types.js";
import { ScriptedLlm, StubDriver } from "./support/doubles.js";

const reporter = { async emit() {} };
const prefix: Step[] = [
  { kind: "goto", url: "https://app/start" },
  { kind: "click", target: { text: "Edit" } },
];
const scenario: Scenario = {
  name: "edit then confirm", steps: prefix,
  assertions: [
    { kind: "custom", name: "editor", params: { after: prefix } },
    { kind: "navigated", to: "https://app/confirmation" },
  ],
};

class RecoveryDriver extends StubDriver {
  entries = 0;
  constructor() {
    super();
    this.navOn.Edit = "https://app/editor";
    this.navOn.Confirm = "https://app/confirmation";
  }
  override async goto(url: string): Promise<void> {
    this.entries++;
    await super.goto(url);
  }
  override async snapshot(): Promise<PageElement[]> {
    if (this.url.endsWith("/editor")) return [
      { role: "heading", name: `Editor attempt ${this.entries}` },
      { role: "button", name: "Confirm" },
    ];
    return this.url.endsWith("/start") ? [{ role: "button", name: "Edit" }]
      : [{ role: "heading", name: "Confirmation" }];
  }
}

function repairModel() {
  const llm = new ScriptedLlm([
    '{"action":"click","text":"Edit"}',
    '{"action":"click","text":"Confirm"}',
    '{"action":"done"}',
    "[]",
  ]);
  return { id: llm.id, complete: vi.fn(() => llm.complete()) };
}

describe("checkpoint outcome-recovery integration", () => {
  it("passes fresh healing captures to original mechanical checks without extra model judgments", async () => {
    const notifications: EvidenceCheckpointRecord[] = [];
    const judgments: Evidence[] = [];
    const driver = new RecoveryDriver();
    const llm = repairModel();
    const outcome = await runScenario(scenario, {
      driver, reporter, llm, heal: true, judgmentKey: "editor-check-v1",
      evidenceCapture: { checkpoints: [
        { id: "replay-editor", after: prefix, elements: true },
        { id: "heal-editor", after: prefix, elements: true, phase: "heal" },
      ], onCapture: record => notifications.push(record) },
      custom: { editor: async (params, evidence) => {
        judgments.push(structuredClone(evidence));
        const after = params.after as Step[];
        const healed = await checkpointEvidence(evidence, { id: "heal-editor", after, phase: "heal" });
        const replayed = await checkpointEvidence(evidence, { id: "replay-editor", after });
        const record = healed ?? replayed;
        if (!record?.elements) return { inconclusive: true, required: true, detail: "Editor evidence missing" };
        const attempt = record.phase === "heal" ? 2 : 1;
        return record.elements.some(element => element.name === `Editor attempt ${attempt}`);
      } },
    });

    expect(judgments).toHaveLength(2);
    expect(judgments[0]?.checkpoints?.map(record => record.phase)).toEqual(["replay"]);
    expect(judgments[1]?.checkpoints?.map(record => record.phase)).toEqual(["heal"]);
    expect(judgments[1]?.captureRunId).not.toBe(judgments[0]?.captureRunId);
    expect(notifications.map(record => record.phase)).toEqual(["replay", "heal"]);
    expect(outcome.result.evidence.captureRunId).toBe(notifications[1]?.runId);
    expect(outcome.result.evidence.checkpoints?.[0]?.elements).toContainEqual({ role: "heading", name: "Editor attempt 2" });
    expect(outcome.result.verdict.passed).toBe(true);
    expect(outcome.healedScenario).toBeDefined();
    expect(driver.clicked).toEqual(["Edit", "Edit", "Confirm"]);
    // Two discovery decisions, done, and the assertion proposal; neither custom judgment calls a model.
    expect(llm.complete).toHaveBeenCalledTimes(4);
    expect(outcome.result.usage?.llmCalls).toBe(4);
  });

  it("cannot fill a missing healing checkpoint with the successful replay checkpoint", async () => {
    const notifications: EvidenceCheckpointRecord[] = [];
    const judgments: Evidence[] = [];
    const llm = repairModel();
    const outcome = await runScenario(scenario, {
      driver: new RecoveryDriver(), reporter, llm, heal: true, judgmentKey: "editor-check-v1",
      evidenceCapture: { checkpoints: [{ id: "replay-editor", after: prefix, elements: true }],
        onCapture: record => notifications.push(record) },
      custom: { editor: async (params, evidence) => {
        judgments.push(structuredClone(evidence));
        const record = await checkpointEvidence(evidence, { id: "replay-editor", after: params.after as Step[] });
        if (!record?.elements) return { inconclusive: true, required: true, detail: "Current attempt has no editor checkpoint" };
        return record.elements.some(element => element.name === "Editor attempt 1");
      } },
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.status).toBe("captured");
    expect(judgments).toHaveLength(2);
    expect(judgments[0]?.checkpoints).toHaveLength(1);
    expect(judgments[1]?.checkpoints).toEqual([]);
    expect(outcome.result.verdict.results[1]?.passed).toBe(true);
    expect(outcome.result.verdict.results[0]).toMatchObject({ reason: "inconclusive", required: true });
    expect(outcome.result.verdict.passed).toBe(false);
    expect(outcome.healedScenario).toBeUndefined();
    expect(llm.complete).toHaveBeenCalledTimes(4);
    expect(outcome.result.usage?.llmCalls).toBe(4);
  });
});

it("marks the required-inconclusive aggregation upgrade as a changed judgment contract", async () => {
  const intent = "edit then confirm";
  const judgmentKey = "editor-check-v1";
  const current = await scenarioContract(scenario, { intent, judgmentKey, localePrefixes: [] });
  const intentHash = await hashContractValue(intent);
  const material = {
    version: 1,
    intentHash,
    assertions: scenario.assertions,
    wildcards: false,
    judgment: { revision: 1, benign: [], benignConsole: [], localePrefixes: [], allowedHosts: null, judgmentKey },
  };
  const legacy = { version: 1, complete: true, intentHash, fingerprint: await hashContractValue(material) };
  expect(current.complete).toBe(true);
  expect(current.fingerprint).toBe(await hashContractValue({ ...material, judgment: { ...material.judgment, revision: 2 } }));
  expect(compareContracts(legacy, current)).toBe("changed");
});
