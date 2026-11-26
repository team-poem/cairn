import { expect, it } from "vitest";
import {
  AssertionCritic, checkpointEvidence, compareContracts, discoverForReplayCleanup, identifyScenario,
  InlineContextProvider, prepareReplayCleanup, runHarness, runWorkflow, StaticPlanner,
  type Assertion, type LlmClient, type PageElement, type RunHarnessOptions, type Scenario, type Step, type Target,
} from "../src/index.js";
import { StubDriver } from "./support/doubles.js";

const baseUrl = "https://documents.test/list";
const intent = "Review documents A, B and C and show the summary";
const ids = ["A", "B", "C"];
const summary = { role: "button", text: "Show summary" };
const judgment = { opaque: false, judgmentKey: "document-heading-v1" };

// The host dispatches an assignment, not a toggle: the first summary click changes the view,
// and a second click keeps it open. Each document has its own detail view before the summary.
class Documents extends StubDriver {
  private readonly buttons = [...ids.map(id => `Open ${id}`), summary.text].map((name, i) =>
    ({ role: "button", name, ref: `fixture-button-${i}` }));
  private beforeClick?: (id: string | undefined) => void;
  private receipt?: string;
  private document?: string;
  summaryVisible = false;
  constructor(private readonly wrongHeading?: string, private readonly summaryOpens = true) { super(); }

  override async snapshot(): Promise<PageElement[]> {
    const heading = this.document ? `Document ${this.document === this.wrongHeading ? "wrong" : this.document}` : "Documents";
    return [
      { role: "heading", name: this.summaryVisible ? "Summary" : heading, ref: "heading", actions: { click: "disallowed" } },
      ...this.buttons,
    ];
  }

  async snapshotForTask() { return this.snapshot(); } // This fixture's references name stable nodes.

  async locateRef(ref: string): Promise<Target> {
    const row = (await this.snapshot()).find(e => e.ref === ref);
    if (!row) throw new Error("unknown fixture reference");
    return { role: row.role, text: row.name };
  }

  armActionOutcomeIdentity(beforeClick?: (id: string | undefined) => void) {
    this.beforeClick = beforeClick;
    this.receipt = undefined;
  }
  takeActionOutcomeIdentity() {
    const receipt = this.receipt;
    this.beforeClick = this.receipt = undefined;
    return receipt;
  }

  override async click(target: Target) {
    const node = this.buttons.find(b => b.role === target.role && b.name === target.text);
    this.beforeClick?.(node?.ref);
    await super.click(target);
    if (this.beforeClick) this.receipt = node?.ref;
    if (target.text === summary.text) { this.summaryVisible = this.summaryOpens; return; }
    const id = ids.find(id => target.text === `Open ${id}`);
    if (!id) throw new Error("unexpected fixture input");
    this.document = id;
    this.url = new URL(`/review/${id}`, baseUrl).href;
  }
}

function discoveryModel() {
  const prompts: string[] = [];
  const choices = ["Documents", ...ids.map(id => `Open ${id}`), summary.text, summary.text];
  const llm: LlmClient = { id: "document-review", async complete(prompt) {
    if (prompt.includes("Propose the verification assertions.")) return "[]";
    const choice = choices[prompts.length];
    prompts.push(prompt);
    if (!choice) return JSON.stringify({ action: "done" });
    const row = prompt.split("\n").find(line => line.includes(`] ${choice}`) && line.includes('ref="'));
    const ref = row?.match(/ref="([^"]+)"/)?.[1];
    if (!ref) throw new Error(`no listed reference for ${choice}`);
    return JSON.stringify({ action: "click", ref });
  } };
  return { prompts, llm };
}

const documentCritic = (driver: Documents) => new AssertionCritic({
  "summary-visible": async () => (await driver.snapshot()).some(row => row.role === "heading" && row.name === "Summary"),
  "document-heading": async (params, evidence) => {
    const record = await checkpointEvidence(evidence, { id: params.id as string, after: params.after as Step[] });
    if (!record?.elements) return { required: true, inconclusive: true, detail: "document not observed" };
    return { passed: record.elements.some(row => row.role === "heading" && row.name === `Document ${params.id}`) };
  },
});

it("removes one authorized repeat while preserving fresh checks for all three discovered documents", async () => {
  const discovery = new Documents(), { prompts, llm } = discoveryModel();
  const { scenario, recording } = await discoverForReplayCleanup(intent, { driver: discovery, baseUrl, llm });
  const rawClicks = ["Open A", "Open B", "Open C", "Show summary", "Show summary"];
  expect(prompts[1]).toContain('not accepting "click"');
  expect(discovery.clicked).toEqual(rawClicks);
  expect(scenario.steps.map(step => step.kind === "click" ? step.target.text : step.kind)).toEqual(["goto", ...rawClicks]);
  expect(scenario.truncated).not.toBe(true);

  // The approved scope is A/B/C, independent of which checks pass on replay. Prefixes end at
  // the original Open actions, before the proposed deletion: cleanup never rewrites a binding.
  const checkpoints = ids.map((id, i) => ({ id, after: scenario.steps.slice(0, i + 2), elements: true }));
  const checks: Assertion[] = checkpoints.map(({ id, after }) => ({ kind: "custom", name: "document-heading", params: { id, after } }));
  const original = await identifyScenario({ ...scenario, assertions: [...scenario.assertions, ...checks,
    { kind: "custom", name: "summary-visible" }] }, { intent, ...judgment });
  const saved = JSON.stringify(original);
  const declaration = { revision: "fixture-v1", scope: "fixture", semantics: "idempotent-click" as const,
    target: summary, repeatIndex: original.steps.length - 1 };
  const approval = await prepareReplayCleanup(original, recording, declaration);
  expect(approval.status).toBe("approved");
  if (approval.status !== "approved") throw new Error(approval.status);

  async function replay(path: Scenario, driver: Documents, replayCleanup?: RunHarnessOptions["replayCleanup"],
    points = checkpoints, localePrefixes?: string[]) {
    const outcome = await runWorkflow({ budget: { maxModelCalls: 0 } }, workflow => runHarness({
      driver, context: new InlineContextProvider(), planner: new StaticPlanner(path), critic: documentCritic(driver), reporter: { async emit() {} },
    }, intent, { judgment, localePrefixes, evidenceCapture: { checkpoints: points }, replayCleanup, workflow: workflow.borrow("review") }));
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error(outcome.status);
    expect(outcome.modelCalls).toBe(0);
    expect(compareContracts(original.contract, outcome.value.verdict.contract)).toBe("same");
    return outcome.value;
  }

  const rawDriver = new Documents();
  const raw = await replay(original, rawDriver);
  expect(rawDriver.clicked).toEqual(rawClicks);
  expect(raw.verdict.passed).toBe(true);

  const optimizedClicks = rawClicks.slice(0, -1);
  const fresh = new Documents();
  const clean = await replay(original, fresh, { approval, declaration });
  expect(fresh.clicked).toEqual(optimizedClicks);
  expect(clean.verdict.passed).toBe(true);
  expect(clean.evidence.checkpoints?.map(c => [c.id, c.status])).toEqual(ids.map(id => [id, "captured"]));
  expect(clean.evidence.captureRunId).not.toBe(raw.evidence.captureRunId);

  const protectedDriver = new Documents();
  const protectedRun = await replay(original, protectedDriver, { approval, declaration }, [
    ...checkpoints, { id: "after-repeat", after: original.steps, elements: true },
  ]);
  expect(protectedRun.replayCleanup).toEqual({ status: "declined", reason: "protected-occurrence" });
  expect(protectedDriver.clicked).toEqual(rawClicks);
  expect(protectedRun.evidence.checkpoints?.at(-1)).toMatchObject({ id: "after-repeat", status: "captured" });
  expect(protectedRun.verdict.passed).toBe(true);

  const changedDriver = new Documents();
  const changed = await replay(original, changedDriver, { approval, declaration }, checkpoints, []);
  expect(changed.replayCleanup).toEqual({ status: "declined", reason: "unsupported-replay" });
  expect(changedDriver.clicked).toEqual(rawClicks);

  const wrong = new Documents("B");
  const regression = await replay(original, wrong, { approval, declaration });
  expect(wrong.clicked).toEqual(optimizedClicks);
  expect(regression.verdict).toMatchObject({ passed: false, failure: "flow" });
  expect(regression.verdict.results.filter(r => r.assertion.kind === "custom").map(r => r.passed)).toEqual([true, false, true, true]);
  expect(regression.evidence.captureRunId).not.toBe(clean.evidence.captureRunId);
  const noSummary = new Documents(undefined, false);
  const missedGoal = await replay(original, noSummary, { approval, declaration });
  expect(noSummary.clicked).toEqual(optimizedClicks);
  expect(missedGoal.verdict).toMatchObject({ passed: false, failure: "flow" });
  expect(missedGoal.verdict.results.filter(r => r.assertion.kind === "custom").map(r => r.passed)).toEqual([true, true, true, false]);
  expect(JSON.stringify(original)).toBe(saved);
});
