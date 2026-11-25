// Synthetic consumer for #338: per-target obligations over an explicit target set, composed
// only from the public #314 checkpoint, #327 selected-item and #329 predicate-selection APIs.
// Everything above the driver double is host code; docs/per-target-obligations.md explains it.
import { describe, expect, it } from "vitest";
import {
  checkpointEvidence,
  CollectionSelectionError,
  compareContracts,
  identifyScenario,
  runScenario,
  selectedItemEquals,
  type Assertion,
  type CollectionObservation,
  type CollectionTarget,
  type CustomChecks,
  type EvidenceCaptureOptions,
  type PageElement,
  type ResourceKeyObservation,
  type Result,
  type RunScenarioOptions,
  type Scenario,
  type SelectedItemBinding,
  type SelectedItemEvidenceOptions,
  type Step,
  type Target,
} from "../src/index.js";
import { StubDriver } from "./support/doubles.js";

type TargetScope = { membership: "established"; targets: string[] } | { membership: "unknown" };

const identity = { kind: "attribute", scope: "item", attribute: "data-resource-id" } as const;
const finish: Step = { kind: "click", target: { text: "Finish" } };

/** "Any eligible item of target T": the target is scope, availability is selection within it. */
function open(target: string): Step {
  return { kind: "click", target: { collection: {
    root: { role: "list", name: "Targets" }, itemRole: "listitem", target: { role: "button", name: "Open" },
    order: "dom", expectedCount: 4, choice: { version: 1, cardinality: 1, policy: "first-dom", identity, maxReselections: 0,
      where: [
        { kind: "attribute-equals", scope: "item", attribute: "data-target", value: target },
        { kind: "attribute-equals", scope: "item", attribute: "data-available", value: "true" },
      ] },
  } } };
}

function opened(after: Step[]): SelectedItemBinding {
  return { version: 1, id: `opened-${targetOf(after.at(-1)!)}`, relation: "resource-key-equals", phase: "replay",
    source: { after, key: identity },
    destination: { after, key: { kind: "attribute", selector: "#detail", attribute: "data-resource-id" } } };
}

function targetOf(step: Step): string | undefined {
  const where = "target" in step ? step.target.collection?.choice?.where : undefined;
  const value = where?.find(p => p.attribute === "data-target")?.value;
  return typeof value === "string" ? value : undefined;
}

/** The approved requirements, persisted as assertion params. Scope never shrinks to what ran. */
function approve(scope: TargetScope): Scenario {
  const targets = scope.membership === "established" ? scope.targets : [];
  if (scope.membership === "established"
    && (targets.length === 0 || targets.length > 32 || new Set(targets).size !== targets.length))
    throw new Error("an established target scope lists 1 to 32 distinct targets");
  const steps = [...targets.map(open), finish];
  return { name: "check every target", steps, assertions: [
    { kind: "custom", name: "target-scope", params: scope },
    ...targets.flatMap((target, i): Assertion[] => {
      const after = steps.slice(0, i + 1);
      return [
        { kind: "custom", name: "target-opened", params: opened(after) as unknown as Record<string, unknown> },
        { kind: "custom", name: "target-heading", params: { version: 1, target, checkpoint: `heading-${target}`, after,
          heading: `Target ${target}` } },
      ];
    }),
    { kind: "navigated", to: "https://app/done" },
  ] };
}

const paramsOf = (scenario: Scenario, name: string) =>
  scenario.assertions.flatMap(a => a.kind === "custom" && a.name === name && a.params ? [a.params] : []);

/** Runtime collection is derived from the persisted declarations on every run, never stored. */
function collection(scenario: Scenario): { evidenceCapture: EvidenceCaptureOptions; selectedItemEvidence: SelectedItemEvidenceOptions } {
  return {
    evidenceCapture: { checkpoints: paramsOf(scenario, "target-heading")
      .map(p => ({ id: p.checkpoint as string, after: p.after as Step[], elements: true })) },
    selectedItemEvidence: { bindings: paramsOf(scenario, "target-opened") as unknown as SelectedItemBinding[] },
  };
}

const landmarks = new Set(["banner", "complementary", "contentinfo", "form", "main", "navigation", "region", "search"]);

/**
 * Headings between the "Detail" region and the "Related" sidebar that follows it, or undefined when
 * the snapshot cannot show where Detail ends. Chrome omits unnamed landmarks from a flat snapshot,
 * so no boundary, or any other landmark first, may hide a sidebar heading inside the span.
 */
function detailHeadings(elements: PageElement[]): string[] | undefined {
  const start = elements.findIndex(e => e.role === "region" && e.name === "Detail");
  if (start < 0) return undefined;
  const rest = elements.slice(start + 1);
  const end = rest.findIndex(e => landmarks.has(e.role));
  if (end < 0 || rest[end]!.role !== "complementary" || rest[end]!.name !== "Related") return undefined;
  return rest.slice(0, end).filter(e => e.role === "heading").map(e => e.name);
}

const checks: CustomChecks = {
  "target-scope": params => params.membership === "established"
    ? { passed: true, detail: "target membership is established" }
    : { inconclusive: true, required: true, detail: "target membership is unknown" },
  "target-opened": selectedItemEquals,
  "target-heading": async (params, evidence) => {
    const record = await checkpointEvidence(evidence, { id: params.checkpoint as string, after: params.after as Step[] });
    const headings = record?.elements && detailHeadings(record.elements);
    if (!headings) return { inconclusive: true, required: true, detail: `detail heading of ${params.target} was not observed` };
    return { passed: headings.includes(params.heading as string), detail: `detail heading of ${params.target}` };
  },
};

interface Coverage {
  targets: number | "unknown";
  passed: string[];
  failed: string[];
  unconfirmed: string[];
  /** Targets whose selected-item obligation passed, and whose detail-heading obligation passed. */
  opened: string[];
  heading: string[];
  route: { completed: number; total: number };
  verified: boolean;
}

/** Aggregate per target, not per action: three visits to A are one target. */
function summarize(scenario: Scenario, result: Result): Coverage {
  const scope = paramsOf(scenario, "target-scope")[0] as TargetScope;
  const outcomes = new Map<string, string[]>(scope.membership === "established" ? scope.targets.map(t => [t, []]) : []);
  const kinds: Record<"opened" | "heading", Set<string>> = { opened: new Set(), heading: new Set() };
  for (const r of result.verdict.results) {
    if (r.assertion.kind !== "custom" || !r.assertion.params) continue;
    const target = r.assertion.name === "target-heading" ? r.assertion.params.target as string
      : r.assertion.name === "target-opened" ? targetOf((r.assertion.params as unknown as SelectedItemBinding).source.after.at(-1)!)
      : undefined;
    if (target !== undefined && r.passed)
      kinds[r.assertion.name === "target-heading" ? "heading" : "opened"].add(target);
    if (target !== undefined) outcomes.get(target)?.push(r.passed ? "passed" : r.reason === "inconclusive" ? "unconfirmed" : "failed");
  }
  const by = (status: string) => [...outcomes].filter(([, list]) =>
    status === "failed" ? list.includes("failed")
      : status === "passed" ? list.length === 2 && list.every(s => s === "passed")
      : !list.includes("failed") && !(list.length === 2 && list.every(s => s === "passed"))).map(([t]) => t);
  const coverage = { targets: scope.membership === "established" ? scope.targets.length : "unknown" as const,
    passed: by("passed"), failed: by("failed"), unconfirmed: by("unconfirmed"),
    opened: [...outcomes.keys()].filter(t => kinds.opened.has(t)), heading: [...outcomes.keys()].filter(t => kinds.heading.has(t)),
    route: { completed: result.evidence.execution.actions.filter(a => a.ok && !a.skipped).length, total: scenario.steps.length } };
  return { ...coverage, verified: result.verdict.passed && scope.membership === "established"
    && coverage.failed.length === 0 && coverage.unconfirmed.length === 0 };
}

/** A same-document list of four members over targets A, B, C; one B member is unavailable. */
class TargetsDriver extends StubDriver {
  readonly items = [
    { target: "A", available: true, key: "private-key-a" },
    { target: "B", available: false, key: "private-key-b-sold-out" },
    { target: "B", available: true, key: "private-key-b" },
    { target: "C", available: true, key: "private-key-c" },
  ];
  readonly headings: Record<string, string> = {};
  readonly sidebar: string[] = [];
  /** Chrome drops an unnamed landmark from the snapshot, so the sidebar boundary can vanish. */
  boundary = true;
  readonly mutations: string[] = [];
  private readonly refs = new Map<string, string>();
  private observations = 0;
  private current?: string;
  captureFails = false;

  async observeCollection(selection: CollectionTarget): Promise<CollectionObservation> {
    this.observations++;
    return { complete: true, order: "dom", conditions: [], items: this.items.map((item, position) => {
      const ref = `ref:${this.observations}:${position}`;
      this.refs.set(ref, item.key);
      return { position, disabled: false, target: { role: "button", name: "Open", ref, disabled: false, occluded: false },
        choice: { complete: true, key: item.key, values: selection.choice!.where.map(p =>
          p.attribute === "data-target" ? item.target : String(item.available)) } };
    }) };
  }
  async clickWithSelectedItemEvidence(_target: Target, ref: string): Promise<ResourceKeyObservation> {
    const key = this.refs.get(ref)!;
    this.mutations.push(key);
    this.current = key;
    return { complete: true, value: key };
  }
  async readResourceKey(): Promise<ResourceKeyObservation> {
    return this.current ? { complete: true, value: this.current } : { complete: false };
  }
  override async click(target: Target): Promise<void> {
    await super.click(target);
    const fixed = this.items.find(item => item.available && target.text === `Open ${item.target}`);
    if (fixed) { this.mutations.push(fixed.key); this.current = fixed.key; }
    if (target.text === "Finish") { this.mutations.push("finish"); this.url = "https://app/done"; this.current = undefined; }
  }
  override async snapshot(): Promise<PageElement[]> {
    if (this.captureFails) throw new Error("snapshot transport failed");
    const item = this.items.find(i => i.key === this.current);
    return [
      { role: "navigation", name: "Targets" },
      { role: "region", name: "Detail" },
      { role: "heading", name: item ? this.headings[item.target] ?? `Target ${item.target}` : "Targets" },
      ...(this.boundary ? [{ role: "complementary", name: "Related" }] : []),
      ...this.sidebar.map(name => ({ role: "heading", name })),
    ];
  }
}

const forbidden = { id: "forbidden", complete: async (): Promise<string> => { throw new Error("replay must not call a model"); } };
const approved = approve({ membership: "established", targets: ["A", "B", "C"] });

async function replay(scenario: Scenario, driver = new TargetsDriver(), options: RunScenarioOptions = collection(scenario)) {
  const { result } = await runScenario(scenario, { driver, reporter: { emit: async () => {} }, llm: forbidden,
    custom: checks, judgmentKey: "per-target-headings-v1", ...options });
  expect(result.usage?.llmCalls).toBe(0);
  return { result, coverage: summarize(scenario, result), driver };
}
const withPath = (steps: Step[]): Scenario => ({ ...approved, steps });

describe("per-target obligations composed from checkpoints and selected-item bindings", () => {
  it("passes in aggregate only when A, B and C each have fresh passing evidence", async () => {
    const { result, coverage, driver } = await replay(approved);
    expect(result.verdict.passed).toBe(true);
    expect(coverage).toEqual({ targets: 3, passed: ["A", "B", "C"], failed: [], unconfirmed: [],
      opened: ["A", "B", "C"], heading: ["A", "B", "C"],
      route: { completed: 4, total: 4 }, verified: true });
    expect(driver.mutations).toEqual(["private-key-a", "private-key-b", "private-key-c", "finish"]);
  });

  it("checking only A leaves B and C unconfirmed although the final assertion passes", async () => {
    const { result, coverage } = await replay(withPath([open("A"), finish]));
    expect(result.verdict.results.at(-1)).toMatchObject({ assertion: { kind: "navigated" }, passed: true });
    expect(result.verdict).toMatchObject({ passed: false, failure: "environment" });
    expect(coverage).toMatchObject({ passed: ["A"], failed: [], unconfirmed: ["B", "C"], verified: false });
  });

  it("keeps B's wrong heading visible after C passes", async () => {
    const driver = new TargetsDriver(); driver.headings.B = "Target A";
    const { result, coverage } = await replay(approved, driver);
    expect(result.verdict).toMatchObject({ passed: false, failure: "flow" });
    expect(coverage).toMatchObject({ passed: ["A", "C"], failed: ["B"], unconfirmed: [], verified: false });
  });

  it("a sidebar heading named for B does not satisfy B's detail heading", async () => {
    const driver = new TargetsDriver(); driver.headings.B = "Wrong"; driver.sidebar.push("Target B");
    const { result, coverage } = await replay(approved, driver);
    expect(result.verdict).toMatchObject({ passed: false, failure: "flow" });
    expect(coverage).toMatchObject({ passed: ["A", "C"], failed: ["B"], verified: false,
      opened: ["A", "B", "C"], heading: ["A", "C"] });
  });

  it("a snapshot that omits the sidebar boundary cannot show where the detail view ends", async () => {
    const driver = new TargetsDriver(); driver.headings.B = "Wrong"; driver.sidebar.push("Target B"); driver.boundary = false;
    const { result, coverage } = await replay(approved, driver);
    expect(result.verdict).toMatchObject({ passed: false, failure: "environment" });
    expect(coverage).toMatchObject({ passed: [], failed: [], unconfirmed: ["A", "B", "C"], heading: [], verified: false });
  });

  it("a later landmark other than the sidebar boundary does not end the detail view", async () => {
    const driver = new TargetsDriver(); driver.headings.B = "Wrong"; driver.sidebar.push("Target B"); driver.boundary = false;
    const snapshot = driver.snapshot.bind(driver);
    driver.snapshot = async () => [...await snapshot(), { role: "contentinfo", name: "Footer" }];
    const { coverage } = await replay(approved, driver);
    expect(coverage).toMatchObject({ passed: [], failed: [], unconfirmed: ["A", "B", "C"], heading: [], verified: false });
  });

  it("a snapshot without a detail view leaves the heading unconfirmed", async () => {
    const driver = new TargetsDriver();
    driver.snapshot = async () => [{ role: "heading", name: "Target A" }];
    const { coverage } = await replay(withPath([open("A"), finish]), driver);
    expect(coverage).toMatchObject({ passed: [], opened: ["A"], heading: [], unconfirmed: ["A", "B", "C"] });
  });

  it("three visits to A satisfy neither B nor C", async () => {
    const repeated = withPath([open("A"), { kind: "click", target: { text: "Open A" } },
      { kind: "click", target: { text: "Open A" } }, finish]);
    const { result, coverage, driver } = await replay(repeated);
    expect(driver.mutations).toEqual(["private-key-a", "private-key-a", "private-key-a", "finish"]);
    expect(new Set(result.evidence.execution.actions.map((_, i) => i)).size).toBe(4);
    expect(coverage).toMatchObject({ passed: ["A"], unconfirmed: ["B", "C"], route: { completed: 4, total: 4 }, verified: false });
    expect(result.evidence.checkpoints?.filter(r => r.id !== "heading-A").map(r => r.reason)).toEqual(["path-changed", "path-changed"]);

    const choices = new TargetsDriver();
    await expect(replay(withPath([open("A"), open("A"), open("A"), finish]), choices)).rejects.toBeInstanceOf(CollectionSelectionError);
    expect(choices.mutations).toEqual([]);
  });

  it("refuses duplicate, empty or oversized scopes and a reordered path before any mutation", async () => {
    expect(() => approve({ membership: "established", targets: ["A", "B", "A"] })).toThrow("distinct");
    expect(() => approve({ membership: "established", targets: [] })).toThrow("distinct");
    expect(() => approve({ membership: "established", targets: Array.from({ length: 33 }, (_, i) => `T${i}`) })).toThrow("distinct");
    const driver = new TargetsDriver();
    await expect(replay(withPath([open("C"), open("B"), open("A"), finish]), driver)).rejects.toBeInstanceOf(CollectionSelectionError);
    expect(driver.mutations).toEqual([]);
  });

  it("reports unknown membership as unknown coverage, not as an empty success", async () => {
    const unknown = approve({ membership: "unknown" });
    const { result, coverage } = await replay(unknown);
    expect(result.verdict.results.at(-1)?.passed).toBe(true);
    expect(result.verdict).toMatchObject({ passed: false, failure: "environment" });
    expect(coverage).toMatchObject({ targets: "unknown", passed: [], failed: [], unconfirmed: [], verified: false });
  });

  it("reaching the final destination without intermediate evidence satisfies nothing", async () => {
    const direct = await replay(withPath([finish]));
    expect(direct.result.verdict.passed).toBe(false);
    expect(direct.coverage).toMatchObject({ passed: [], unconfirmed: ["A", "B", "C"], route: { completed: 1, total: 1 } });

    const uncaptured = await replay(approved, new TargetsDriver(), { selectedItemEvidence: collection(approved).selectedItemEvidence });
    expect(uncaptured.result.verdict.passed).toBe(false);
    expect(uncaptured.coverage).toMatchObject({ passed: [], unconfirmed: ["A", "B", "C"], verified: false });
  });

  it("a completed route with unsupported destination reads does not claim verified completion", async () => {
    const driver = new TargetsDriver();
    Object.defineProperty(driver, "readResourceKey", { value: undefined });
    const { result, coverage } = await replay(approved, driver);
    expect(result.evidence.selectedItems?.map(r => r.complete)).toEqual([false, false, false]);
    expect(result.verdict).toMatchObject({ passed: false, failure: "environment" });
    expect(coverage).toMatchObject({ route: { completed: 4, total: 4 }, passed: [], failed: [], unconfirmed: ["A", "B", "C"], verified: false });
  });

  it("re-evaluates every obligation on a fresh replay without prior-run evidence or flags", async () => {
    const saved = JSON.stringify(approved);
    const first = await replay(approved);
    const reset = new TargetsDriver(); reset.headings.C = "Target B";
    const second = await replay(approved, reset);
    expect(JSON.stringify(approved)).toBe(saved);
    expect(saved).not.toMatch(/captured|runId|private-key/);
    expect(first.coverage.verified).toBe(true);
    expect(second.coverage).toMatchObject({ passed: ["A", "B"], failed: ["C"], verified: false });
    expect(second.result.evidence.captureRunId).not.toBe(first.result.evidence.captureRunId);
    expect(second.result.evidence.selectedItemRunId).not.toBe(first.result.evidence.selectedItemRunId);

    const stale = { ...second.result.evidence, checkpoints: first.result.evidence.checkpoints, selectedItems: first.result.evidence.selectedItems };
    const [, , heading] = paramsOf(approved, "target-heading");
    expect(await checks["target-heading"]!(heading!, stale)).toMatchObject({ inconclusive: true, required: true });
    expect(await selectedItemEquals(paramsOf(approved, "target-opened")[2]!, stale)).toMatchObject({ inconclusive: true, required: true });
  });

  it("changed paths and obligation definitions do not reuse incompatible evidence", async () => {
    const edited = withPath([open("A"), { kind: "click", target: { text: "Open B" } }, open("C"), finish]);
    await expect(replay(edited)).rejects.toBeInstanceOf(CollectionSelectionError);

    const fixedB = withPath([open("A"), { kind: "click", target: { text: "Open B" } }, finish]);
    const rerouted = await replay(fixedB);
    expect(rerouted.coverage).toMatchObject({ passed: ["A"], unconfirmed: ["B", "C"] });

    const stalePolicy = collection(approved);
    stalePolicy.evidenceCapture = { checkpoints: stalePolicy.evidenceCapture.checkpoints.map(p => ({ ...p, after: p.after.slice(-1) })) };
    const rebound = await replay(approved, new TargetsDriver(), stalePolicy);
    expect(rebound.coverage).toMatchObject({ passed: ["A"], unconfirmed: ["B", "C"] });

    const full = await replay(approved);
    const heading = paramsOf(approved, "target-heading")[1]!;
    expect(await checks["target-heading"]!(heading, full.result.evidence)).toMatchObject({ passed: true });
    const moved = { ...heading, after: [open("B")] };
    expect(await checks["target-heading"]!(moved, full.result.evidence)).toMatchObject({ inconclusive: true, required: true });

    const strengthened: Scenario = { ...approved, assertions: approved.assertions.map(a => a.kind === "custom" && a.name === "target-heading"
      && a.params?.target === "B" ? { ...a, params: { ...a.params, heading: "Target B, revised" } } : a) };
    const intent = { intent: "Check the heading of every approved target" };
    const before = await replay(await identifyScenario(structuredClone(approved), intent));
    const after = await replay(await identifyScenario(strengthened, intent));
    expect(compareContracts(before.result.verdict.contract, after.result.verdict.contract)).toBe("changed");
    expect(after.coverage).toMatchObject({ failed: ["B"], verified: false });
  });

  it("capture failure stays unconfirmed and never repeats a mutation", async () => {
    const driver = new TargetsDriver(); driver.captureFails = true;
    const { result, coverage } = await replay(approved, driver);
    expect(driver.mutations).toEqual(["private-key-a", "private-key-b", "private-key-c", "finish"]);
    expect(result.evidence.checkpoints?.map(r => r.reason)).toEqual(["capture-failed", "capture-failed", "capture-failed"]);
    expect(coverage).toMatchObject({ unconfirmed: ["A", "B", "C"], verified: false });
  });

  it("keeps a single-final-state scenario's serialized form and contract", async () => {
    const legacy: Scenario = { name: "finish", steps: [finish], assertions: [{ kind: "navigated", to: "https://app/done" }] };
    const identified = await identifyScenario(structuredClone(legacy), { intent: "Finish" });
    const saved = JSON.stringify(identified);
    const { result } = await runScenario(identified, { driver: new TargetsDriver(), reporter: { emit: async () => {} }, llm: forbidden });
    expect(result.verdict.passed).toBe(true);
    expect(JSON.stringify(identified)).toBe(saved);
    expect(compareContracts(identified.contract, result.verdict.contract)).toBe("same");
    expect(Object.keys(JSON.parse(saved)).sort()).toEqual(["assertions", "contract", "name", "steps"]);
  });

  it("reports bounded labels and outcomes without raw resource keys or references", async () => {
    const driver = new TargetsDriver(); driver.headings.B = "Wrong";
    const { result, coverage } = await replay(approved, driver);
    expect(result.evidence.selectedItems?.every(r => r.equal !== undefined)).toBe(true);
    expect(result.evidence.checkpoints?.every(r => r.elements?.length === 4)).toBe(true);
    expect(JSON.stringify({ scenario: approved, result, coverage })).not.toMatch(/private-key|ref:/);
  });
});
