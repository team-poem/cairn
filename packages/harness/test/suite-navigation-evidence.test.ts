import { afterEach, describe, expect, it, vi } from "vitest";
import { hashCase, runSuite } from "../src/suite.js";
import type { SuiteCase, SuiteVerdict } from "../src/suite.js";
import type { Evidence, NetworkRequest, Scenario, Target } from "../src/core/types.js";
import type { SkillStore } from "../src/core/ports.js";
import type { TraceEvent } from "../src/core/trace.js";
import { renderSuiteReport } from "../src/adapters/reporters/suite.js";
import { ScriptedLlm, StubDriver } from "./support/doubles.js";

class MemoryStore implements SkillStore {
  scenario?: Scenario;
  async load(): Promise<Scenario> {
    if (!this.scenario) throw new Error("missing");
    return this.scenario;
  }
  async freeze(ref: string, scenario: Scenario): Promise<string> { this.scenario = scenario; return ref; }
}

class SaveDriver extends StubDriver {
  readonly requests: NetworkRequest[] = [];
  constructor() {
    super("https://shop/start");
    this.navOn.Form = "https://shop/form";
  }
  override async click(target: Target): Promise<void> {
    await super.click(target);
    if (target.text === "Save") this.requests.push({ method: "POST", url: "https://shop/api/save", status: 200 });
  }
  override async observe(): Promise<Evidence> {
    const evidence = await super.observe();
    return { ...evidence, logic: { ...evidence.logic, requests: this.requests } };
  }
}

const CASE: SuiteCase = { id: "save", intent: "save the form", url: "https://shop/start" };
const marked = { kind: "navigated" as const, to: "shop/form", origin: "derived" as const, observedBeforeLastMutation: true as const };
const silent = { emit: async () => {} };
const saveLlm = () => new ScriptedLlm([
  '{"action":"click","text":"Form"}',
  '{"action":"click","text":"Save"}',
  '{"action":"done","assertions":[{"kind":"request-status","urlIncludes":"/api/save","status":200}]}',
  "[]",
]);

describe("suite navigation evidence summaries (#203)", () => {
  afterEach(() => vi.useRealTimers());

  it("exposes a fresh on-page save advisory through freeze, onCase, report and cached replay without failing", async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    const events: TraceEvent[] = [];
    const cases: SuiteVerdict[] = [];
    const run = runSuite([CASE], {
      store, driverFactory: () => new SaveDriver(), llm: saveLlm(), reporter: silent,
      trace: { emit: (event) => { events.push(event); } }, onCase: (v) => { cases.push(v); },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const fresh = await run;
    expect(fresh.verdicts[0]).toMatchObject({
      observedBeforeLastMutation: ["shop/form"], discovered: true, verdict: { passed: true },
    });
    expect(events.find((e) => e.kind === "freeze")?.payload).toMatchObject({ observedBeforeLastMutation: ["shop/form"] });
    expect(events[0]?.payload).toMatchObject({ version: "1.3" });
    expect(cases).toEqual(fresh.verdicts);
    expect(renderSuiteReport(fresh)).toContain("destination observed before last mutation: shop/form");
    expect(store.scenario).not.toHaveProperty("observedBeforeLastMutation");
    const cached = await runSuite([CASE], {
      store, driverFactory: () => new SaveDriver(), reporter: silent,
      llm: { id: "forbidden", complete: async () => { throw new Error("cached replay called LLM"); } },
    });
    expect(cached.verdicts[0]).toMatchObject({
      observedBeforeLastMutation: ["shop/form"], discovered: false, verdict: { passed: true }, usage: { llmCalls: 0 },
    });
  });

  it.each([true, false])("outcome-heal summarizes preserved original assertions (original marker %s)", async (originalMarked) => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    store.scenario = {
      name: CASE.intent,
      steps: [{ kind: "goto", url: CASE.url! }, { kind: "click", target: { text: "Old form" } }],
      assertions: [originalMarked ? marked : { kind: "navigated", to: "shop/form", origin: "user" }],
      ...{ caseHash: hashCase(CASE) },
    };
    const events: TraceEvent[] = [];
    const done = runSuite([CASE], {
      store, driverFactory: () => new SaveDriver(), llm: saveLlm(), reporter: silent,
      trace: { emit: (event) => { events.push(event); } },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const suite = await done;
    const freeze = events.find((e) => e.kind === "freeze");
    expect(freeze).toMatchObject({ phase: "heal" });
    expect(suite.passed).toBe(true);
    if (originalMarked) {
      expect(freeze?.payload).toMatchObject({ observedBeforeLastMutation: ["shop/form"] });
      expect(suite.verdicts[0]).toMatchObject({ observedBeforeLastMutation: ["shop/form"] });
    } else {
      expect(freeze?.payload).not.toHaveProperty("observedBeforeLastMutation");
      expect(suite.verdicts[0]).not.toHaveProperty("observedBeforeLastMutation");
    }
    expect(store.scenario?.assertions).toEqual([originalMarked ? marked : { kind: "navigated", to: "shop/form", origin: "user" }]);
  });

  it("omits empty summaries from fresh freeze, verdict and report", async () => {
    const events: TraceEvent[] = [];
    const suite = await runSuite([CASE], {
      store: new MemoryStore(), driverFactory: () => new SaveDriver(), reporter: silent,
      llm: new ScriptedLlm(['{"action":"click","text":"Form"}', '{"action":"done"}', "[]"]),
      trace: { emit: (event) => { events.push(event); } },
    });
    expect(suite.passed).toBe(true);
    expect(events.find((e) => e.kind === "freeze")?.payload).not.toHaveProperty("observedBeforeLastMutation");
    expect(suite.verdicts[0]).not.toHaveProperty("observedBeforeLastMutation");
    expect(renderSuiteReport(suite)).not.toContain("destination observed before last mutation");
  });

  it("outcome-heal forwards consumer-benign traffic rules without spending the redirect budget", async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    store.scenario = {
      name: CASE.intent,
      steps: [{ kind: "goto", url: CASE.url! }],
      assertions: [{ kind: "navigated", to: "shop/form", origin: "user" }],
      ...{ caseHash: hashCase(CASE) },
    };
    let completed = false;
    const done = runSuite([CASE], {
      store, driverFactory: () => new SaveDriver(), llm: saveLlm(), reporter: silent,
      benign: ["/api/save"],
    }).then((result) => { completed = true; return result; });
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(true);
    expect((await done).passed).toBe(true);
    expect(store.scenario?.steps.at(-1)).not.toHaveProperty("expect");
  });
});
