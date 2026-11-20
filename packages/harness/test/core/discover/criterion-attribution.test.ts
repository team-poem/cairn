import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discover } from "../../../src/core/discover/index.js";
import { deriveAssertions, unattributedCriteria } from "../../../src/core/discover/grounding.js";
import { scenarioContract } from "../../../src/core/contract.js";
import { runScenario } from "../../../src/run.js";
import { hashCase } from "../../../src/suite.js";
import { loadSkillFile, saveSkillFile } from "../../../src/adapters/skills/file-store.js";
import { FakeDriver } from "../../../src/adapters/drivers/fake.js";
import { startTrace } from "../../../src/core/trace.js";
import type { TraceEvent } from "../../../src/core/trace.js";
import type { Evidence, HostCriterion, Scenario } from "../../../src/core/types.js";
import { ScriptedLlm } from "../../support/doubles.js";

const CRITERIA: HostCriterion[] = [
  { id: "C1", text: "add the item to the basket" },
  { id: "C2", text: "show a confirmation" },
];
const ADD = { method: "POST", url: "https://shop.co/api/basket/items", status: 200 };
const ELEMENTS = [{ role: "button", name: "Add" }];

/** The POST lands only when the flow acts, so it is the flow's own request, not the entry load's. */
function liveDriver(): FakeDriver {
  const live: Evidence = {
    execution: { actions: [], navigated: false, finalUrl: "https://shop.co/", blocked: false },
    perception: {},
    logic: { requests: [], console: [] },
  };
  return new (class extends FakeDriver {
    override async click(): Promise<void> {
      live.logic.requests.push({ ...ADD });
    }
    // A snapshot, so the entry-load baseline discover keeps does not grow with the flow's request.
    override async observe(): Promise<Evidence> {
      return structuredClone(live);
    }
  })({ evidence: live, elements: ELEMENTS });
}

const proposal = (over: Record<string, unknown> = {}) =>
  JSON.stringify([{ kind: "request-status", urlIncludes: "/api/basket/items", status: 200, method: "POST", ...over }]);

async function freeze(proposed: string, criteria?: HostCriterion[], trace?: Parameters<typeof discover>[1]["trace"]) {
  const llm = new ScriptedLlm(['{"action":"click","text":"Add"}', '{"action":"done"}', proposed]);
  return discover("add to basket", { driver: liveDriver(), llm, criteria, trace });
}

/** Records every prompt and system text the model is sent. */
class RecordingLlm extends ScriptedLlm {
  readonly sent: string[] = [];
  override async complete(prompt?: string, opts?: unknown): Promise<string> {
    this.sent.push(`${prompt}\n${JSON.stringify(opts)}`);
    return super.complete();
  }
}

const requestChecks = (s: Scenario) => s.assertions.filter((a) => a.kind === "request-status");

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "cairn-355-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("criterion attribution (#355)", () => {
  it("AC1: a grounded check proposed for C1 keeps C1 through freeze, save/load and replay; C2 is reported", async () => {
    const frozen = await freeze(proposal({ criterionIds: ["C1"] }), CRITERIA);
    expect(requestChecks(frozen)).toEqual([
      { kind: "request-status", urlIncludes: "shop.co/api/basket/items", status: 200, method: "POST", criterionIds: ["C1"], origin: "derived" },
    ]);
    expect(frozen.unattributedCriteria).toEqual(["C2"]);

    const file = join(dir, "basket.skill.json");
    await saveSkillFile(file, frozen);
    const loaded = await loadSkillFile(file);
    expect(requestChecks(loaded)[0]).toMatchObject({ criterionIds: ["C1"] });
    expect(loaded.unattributedCriteria).toEqual(["C2"]);

    const replayed = await runScenario(loaded, { driver: liveDriver(), reporter: { emit: async () => {} } });
    const result = replayed.result.verdict.results.find((r) => r.assertion.kind === "request-status");
    expect(result).toMatchObject({ passed: true, assertion: { criterionIds: ["C1"] } });
    expect(replayed.result.usage?.llmCalls ?? 0).toBe(0);
  });

  it("AC1: the freeze trace carries the same unattributed list (suite-owned freeze event shape)", async () => {
    const { runSuite } = await import("../../../src/suite.js");
    const events: TraceEvent[] = [];
    const store = new (class {
      scenario?: Scenario;
      async load(): Promise<Scenario> { if (!this.scenario) throw new Error("missing"); return this.scenario; }
      async freeze(ref: string, s: Scenario): Promise<string> { this.scenario = s; return ref; }
    })();
    await runSuite([{ id: "basket", intent: "add to basket", url: "https://shop.co/", criteria: CRITERIA }], {
      store,
      driverFactory: () => liveDriver(),
      llm: new ScriptedLlm(['{"action":"click","text":"Add"}', '{"action":"done"}', proposal({ criterionIds: ["C1"] })]),
      reporter: { emit: async () => {} },
      trace: { emit: (e) => { events.push(e); } },
    });
    expect(events.find((e) => e.kind === "freeze")?.payload).toMatchObject({ unattributedCriteria: ["C2"] });
    expect(store.scenario?.unattributedCriteria).toEqual(["C2"]);
  });

  it("AC2: a proposal that fails grounding freezes nothing and leaves its criterion unattributed", async () => {
    const events: TraceEvent[] = [];
    const sink = { emit: (e: TraceEvent) => { events.push(e); } };
    const frozen = await freeze(
      proposal({ urlIncludes: "/api/never-called", criterionIds: ["C1"] }),
      CRITERIA,
      startTrace(sink, "0.0.0").scope("c"),
    );
    expect(requestChecks(frozen)).toEqual([]);
    expect(frozen.unattributedCriteria).toEqual(["C1", "C2"]);
    expect(events.find((e) => e.kind === "gate")?.payload).toMatchObject({ gate: "grounding" });
  });

  it("AC3: an unknown id is dropped beside a valid one; with none valid the grounded check stays, unattributed", async () => {
    const mixed = await freeze(proposal({ criterionIds: ["NOPE", "C1"] }), CRITERIA);
    expect(requestChecks(mixed)[0]).toMatchObject({ criterionIds: ["C1"] });

    const none = await freeze(proposal({ criterionIds: ["NOPE", 7, "c1"] }), CRITERIA);
    expect(requestChecks(none)).toHaveLength(1);
    expect(requestChecks(none)[0]).not.toHaveProperty("criterionIds");
    expect(none.unattributedCriteria).toEqual(["C1", "C2"]);
  });

  it("AC3: criterion ids are never invented from a proposal when the host supplied no criteria", async () => {
    const frozen = await freeze(proposal({ criterionIds: ["C1"] }));
    expect(requestChecks(frozen)[0]).not.toHaveProperty("criterionIds");
    expect(frozen).not.toHaveProperty("unattributedCriteria");
  });

  it("AC4: attribution does not change the check's result, grade, fail-closed state or contract", async () => {
    const attributed = await freeze(proposal({ criterionIds: ["C2"] }), CRITERIA); // misattributed on purpose
    const plain = await freeze(proposal());
    const strip = (s: Scenario): Scenario => ({
      ...s,
      assertions: s.assertions.map(({ ...a }) => { delete (a as { criterionIds?: unknown }).criterionIds; return a; }),
    });
    expect(strip(attributed).assertions).toEqual(plain.assertions);

    const run = (s: Scenario) => runScenario(s, { driver: liveDriver(), reporter: { emit: async () => {} } });
    const [a, b] = [await run(attributed), await run(plain)];
    const view = (v: typeof a.result.verdict) => ({
      ...v,
      results: v.results.map((r) => ({ ...r, assertion: strip({ ...plain, assertions: [r.assertion] }).assertions[0] })),
    });
    expect(view(a.result.verdict)).toEqual(view(b.result.verdict));
    expect(a.result.verdict.proof?.grade).toBe("work");
    expect(a.result.verdict.proof).toEqual(b.result.verdict.proof);
    expect(await scenarioContract(attributed, { intent: "x" })).toEqual(await scenarioContract(plain, { intent: "x" }));
  });

  it("AC5: with no criteria, freeze output and the proposer prompt are unchanged", async () => {
    const llm = new RecordingLlm(['{"action":"click","text":"Add"}', '{"action":"done"}', proposal()]);
    const frozen = await discover("add to basket", { driver: liveDriver(), llm, baseUrl: "https://shop.co/" });
    expect(JSON.stringify(frozen)).toBe(
      '{"name":"add to basket","steps":[{"kind":"goto","url":"https://shop.co/"},{"kind":"click","target":{"text":"Add","role":"button","index":0},"expect":{"requestStatus":{"urlIncludes":"shop.co/api/basket/items","status":200,"method":"POST"}}}],' +
      '"assertions":[{"kind":"no-failed-requests","origin":"derived","vacuous":true},{"kind":"no-console-errors","origin":"derived","vacuous":true},' +
      '{"kind":"request-status","urlIncludes":"shop.co/api/basket/items","status":200,"method":"POST","origin":"derived"}],' +
      '"contract":{"version":1,"fingerprint":"7a169b5b927466e2cfa7cbcf0566ca67632cac42a04b9592922e7d94f72a61be","intentHash":"da44556852b5f4ffdf25b5f892764a09a4d69c74209002b77900ee12a27f8cc0","complete":true}}',
    );
    expect(llm.sent.join("\n")).not.toMatch(/criterion|Approved/i);
    expect(hashCase({ id: "a", intent: "i", url: "u" })).toBe("8f8896583eb513ca46625b57032beb734bc8a295f218b865539f47ad0b4c538c");
    expect(hashCase({ id: "a", intent: "i", url: "u", criteria: [] })).toBe(hashCase({ id: "a", intent: "i", url: "u" }));
  });

  it("the proposer is told the criteria only when some were supplied", async () => {
    const llm = new RecordingLlm(['{"action":"click","text":"Add"}', '{"action":"done"}', proposal()]);
    await discover("add to basket", { driver: liveDriver(), llm, criteria: CRITERIA });
    expect(llm.sent.at(-1)).toContain("C2: show a confirmation");
  });

  it("two proposals collapsing onto one endpoint merge their ids", () => {
    const evidence: Evidence = {
      execution: { actions: [], navigated: false, finalUrl: "https://shop.co/", blocked: false },
      perception: {},
      logic: { requests: [{ ...ADD }], console: [] },
    };
    const out = deriveAssertions(
      [
        { kind: "request-status", urlIncludes: "/api/basket/items", status: 200, criterionIds: ["C1"] },
        { kind: "request-status", urlIncludes: "/api/basket/items", status: 200, criterionIds: ["C2", "C1"] },
      ],
      evidence, false, [], undefined, CRITERIA,
    );
    expect(out.filter((a) => a.kind === "request-status")).toMatchObject([{ criterionIds: ["C1", "C2"] }]);
    expect(unattributedCriteria(CRITERIA, out)).toEqual([]);
  });

  it("refuses duplicate or empty criterion ids before any model call", async () => {
    const llm = new ScriptedLlm([]);
    await expect(discover("x", { driver: liveDriver(), llm, criteria: [CRITERIA[0]!, CRITERIA[0]!] })).rejects.toThrow(/duplicate criterion id/);
    await expect(discover("x", { driver: liveDriver(), llm, criteria: [{ id: " ", text: "t" }] })).rejects.toThrow(/non-empty/);
  });
});
