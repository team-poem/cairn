import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSuite, hashCase } from "../src/suite.js";
import type { FrozenSuiteScenario, SuiteCase } from "../src/suite.js";
import { renderSuiteReport } from "../src/adapters/reporters/suite.js";
import { FileSkillStore } from "../src/adapters/skills/file-store.js";
import { JsonReporter } from "../src/adapters/reporters/json.js";
import { ScriptedLlm, StubDriver } from "./support/doubles.js";
import type { LlmClient, Reporter, Scenario, SkillStore, TraceEvent } from "../src/index.js";

/** In-memory SkillStore — lets a test inspect exactly what the suite froze. */
class MemoryStore implements SkillStore {
  readonly skills = new Map<string, Scenario>();
  async load(ref: string): Promise<Scenario> {
    const s = this.skills.get(ref);
    if (!s) throw new Error(`missing skill: ${ref}`);
    return s;
  }
  async freeze(ref: string, scenario: Scenario): Promise<string> {
    this.skills.set(ref, scenario);
    return ref;
  }
}

/** An LlmClient that must never be reached — proves a path made zero LLM calls. */
const forbiddenLlm: LlmClient = {
  id: "forbidden",
  complete: async () => {
    throw new Error("this path must not call the LLM");
  },
};

const silent: Reporter = { emit: async () => {} };

const shopDriver = (): StubDriver => {
  const d = new StubDriver("https://shop/");
  d.els = [{ role: "link", name: "Products" }];
  d.navOn["Products"] = "https://shop/products";
  return d;
};

/** The shop, where clicking Products also fires a DELETE the flow cannot prove (#184): the request
 * log grows only on the click, so the mutation is the flow's own, and its numeric path gives
 * grounding nothing stable to check. `requests` is shared so a test can reset it between runs. */
function unprovenShop(): { driverFactory: () => StubDriver; requests: unknown[] } {
  const requests: { method: string; url: string; status: number }[] = [];
  const driverFactory = (): StubDriver => {
    const d = new (class extends StubDriver {
      override async click(t: Parameters<StubDriver["click"]>[0]): Promise<void> {
        await super.click(t);
        requests.push({ method: "DELETE", url: "https://shop/586738", status: 200 });
      }
      override async observe(): Promise<Awaited<ReturnType<StubDriver["observe"]>>> {
        const e = await super.observe();
        return { ...e, logic: { ...e.logic, requests: [...requests] } };
      }
    })("https://shop/");
    d.els = [{ role: "link", name: "Products" }];
    d.navOn["Products"] = "https://shop/products";
    return d;
  };
  return { driverFactory, requests };
}

const frozen: Scenario = {
  name: "open the catalog",
  steps: [
    { kind: "goto", url: "https://shop/" },
    { kind: "click", target: { text: "Products" } },
  ],
  assertions: [{ kind: "navigated" }],
};

const CASE: SuiteCase = { id: "catalog", intent: "open the catalog", url: "https://shop/" };
const REF = "skills/catalog.skill.json";

/** Stamps a `caseHash` onto a fixture scenario — a plain `{ ...s, caseHash }` literal assigned
 * straight into `MemoryStore.skills` (typed `Scenario`) trips TS's excess-property check, since
 * `caseHash` is a suite-local extension (`FrozenSuiteScenario`), not part of core `Scenario`. */
function withCaseHash(s: Scenario, c: SuiteCase): FrozenSuiteScenario {
  return { ...s, caseHash: hashCase(c) };
}

describe("runSuite", () => {
  it("replays a cached skill with zero LLM calls — the per-case economics invariant", async () => {
    const store = new MemoryStore();
    store.skills.set(REF, withCaseHash(frozen, CASE));

    const suite = await runSuite([CASE], {
      store,
      driverFactory: shopDriver,
      llm: forbiddenLlm,
      reporter: silent,
    });

    expect(suite.passed).toBe(true);
    expect(suite.verdicts).toEqual([
      expect.objectContaining({ id: "catalog", discovered: false, heals: 0, skillRef: REF }),
    ]);
    expect(suite.usage.llmCalls).toBe(0);
  });

  it("discovers a missing case, merges the USER's criteria into the freeze, then replays", async () => {
    const store = new MemoryStore();
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Products","reason":"open catalog"}',
      '{"action":"done"}',
      "[]", // discover's assertion proposal
      '{"passed":true,"detail":"catalog reached"}', // LlmCritic judging the user's expect
    ]);

    const suite = await runSuite(
      [
        {
          ...CASE,
          expect: ["the catalog page lists products"],
          assertions: [{ kind: "navigated", to: "shop/products" }],
        },
      ],
      { store, driverFactory: shopDriver, llm, reporter: silent },
    );

    expect(suite.verdicts[0]).toMatchObject({ discovered: true, verdict: { passed: true } });
    // The freeze carries the user's criteria, not just discover's self-derived assertions —
    // discover only proves what the run did; the user's expected outcome is the test.
    const skill = store.skills.get(REF)!;
    expect(skill.assertions).toEqual(
      expect.arrayContaining([
        { kind: "navigated", to: "shop/products", origin: "user" },
        { kind: "expect", criterion: "the catalog page lists products", origin: "user" },
      ]),
    );
    // discover's own grounded assertions carry `derived` — the freeze can tell the two apart.
    expect(skill.assertions.some((a) => a.origin === "derived")).toBe(true);
    expect(suite.usage.llmCalls).toBe(4); // 3 discovery + 1 expect judgment
  });

  it("first run discovers, second run replays LLM-free (mechanical-only case)", async () => {
    const store = new MemoryStore();
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Products","reason":"open catalog"}',
      '{"action":"done","assertions":[{"kind":"navigated"}]}',
      "[]",
    ]);

    const first = await runSuite([CASE], { store, driverFactory: shopDriver, llm, reporter: silent });
    expect(first.verdicts[0]!.discovered).toBe(true);
    expect(first.usage.llmCalls).toBe(3);

    const second = await runSuite([CASE], {
      store,
      driverFactory: shopDriver,
      llm: forbiddenLlm,
      reporter: silent,
    });
    expect(second.verdicts[0]!.discovered).toBe(false);
    expect(second.usage.llmCalls).toBe(0);
    expect(second.passed).toBe(true);
  });

  it("fails a truncated discovery closed — nothing frozen, nothing replayed", async () => {
    const store = new MemoryStore();
    const llm = new ScriptedLlm(Array(9).fill('{"action":"click","text":"Products"}')); // never done

    const suite = await runSuite([{ ...CASE, maxSteps: 2 }], {
      store,
      driverFactory: shopDriver,
      llm,
      reporter: silent,
    });

    expect(suite.passed).toBe(false);
    expect(suite.verdicts[0]).toMatchObject({
      discovered: true,
      truncated: true,
      verdict: { passed: false },
    });
    expect(suite.verdicts[0]!.verdict.detail).toContain("truncated");
    expect(store.skills.size).toBe(0);
  });

  it("carries an unproven action onto the verdict and the report line — on discovery and on the cached replay (#190)", async () => {
    const store = new MemoryStore();
    const { driverFactory, requests } = unprovenShop();
    const llm = new ScriptedLlm(['{"action":"click","text":"Products"}', '{"action":"done"}', "[]"]);
    const action = "DELETE https://shop/586738";

    const suite = await runSuite([CASE], { store, driverFactory, llm, reporter: silent });
    expect(suite.verdicts[0]).toMatchObject({ discovered: true, unprovenAction: action, verdict: { passed: true } });
    expect(renderSuiteReport(suite)).toContain(`discovered + replayed · ⚠ unproven action: ${action}`);

    // The flag lives on the frozen skill, so the cached replay (LLM 0) still says it.
    requests.length = 0;
    const cached = await runSuite([CASE], { store, driverFactory, llm: forbiddenLlm, reporter: silent });
    expect(cached.verdicts[0]).toMatchObject({ discovered: false, unprovenAction: action });
    expect(renderSuiteReport(cached)).toContain(`replayed (cached) · ⚠ unproven action: ${action}`);
  });

  it("re-freezes a healed scenario so the NEXT run replays clean", async () => {
    const store = new MemoryStore();
    // Frozen step targets "Checkout" whose expect diverges; the live page has "Checkout Now".
    const staleSkill: FrozenSuiteScenario = {
      name: "checkout",
      steps: [
        {
          kind: "click",
          target: { text: "Checkout" },
          intent: "go to payment",
          expect: { url: "app/payment" },
        },
      ],
      assertions: [{ kind: "navigated" }],
      caseHash: hashCase(CASE),
    };
    store.skills.set(REF, staleSkill);
    const driverFactory = (): StubDriver => {
      const d = new StubDriver();
      d.els = [{ role: "button", name: "Checkout Now" }];
      d.navOn["Checkout Now"] = "https://app/payment";
      return d;
    };
    const llm = new ScriptedLlm(['{"action":"click","text":"Checkout Now"}']); // surgical heal

    const suite = await runSuite([{ ...CASE, id: "catalog" }], {
      store,
      driverFactory,
      llm,
      reporter: silent,
      expectTimeoutMs: 50,
    });

    expect(suite.verdicts[0]).toMatchObject({ verdict: { passed: true }, heals: 1 });
    const refrozen = store.skills.get(REF)!;
    expect(refrozen.steps[0]).toMatchObject({ target: { text: "Checkout Now" } });
  });

  it("outcome-heal re-freeze keeps the caseHash — the NEXT run cache-hits instead of re-discovering (#153)", async () => {
    // Real FileSkillStore + JsonReporter — doubles only where a unit test can't avoid them
    // (browser, LLM). The bug's production path is a skill FILE: the re-stamped hash must
    // survive an actual JSON round-trip, which an in-memory store cannot prove.
    const dir = await mkdtemp(join(tmpdir(), "cairn-153-"));
    try {
      const store = new FileSkillStore(dir);
      const reporter = new JsonReporter(join(dir, "result.json"));
      // Frozen with a step that goes nowhere ("Catalog" is not on the page), so replay never reaches
      // shop/products and fails its verdict — which triggers the outcome-heal re-discovery. That
      // re-discovery clicks Products and lands on the goal: only a heal that reached the goal is
      // handed back to re-freeze (#186), so this is the shape a re-freeze can be observed on.
      const stale: FrozenSuiteScenario = {
        ...frozen,
        steps: [{ kind: "goto", url: "https://shop/" }, { kind: "click", target: { text: "Catalog" } }],
        assertions: [{ kind: "navigated", to: "shop/products" }],
        caseHash: hashCase(CASE),
      };
      await store.freeze(REF, stale);
      const llm = new ScriptedLlm(['{"action":"click","text":"Products"}', '{"action":"done"}', "[]"]);

      const first = await runSuite([CASE], { store, driverFactory: shopDriver, llm, reporter });
      expect(first.verdicts[0]!.discovered).toBe(false); // cache hit, then heal — not a fresh discover

      // The repaired scenario came from discover() without the suite-local caseHash; the re-freeze
      // must re-stamp it, or the next run mismatches the hash and pays discovery for nothing.
      // Read back through the real store: the stamp survived serialization.
      const refrozen = (await store.load(REF)) as FrozenSuiteScenario;
      expect(refrozen.steps).toContainEqual(expect.objectContaining({ target: { text: "Products" } })); // the store really was rewritten…
      expect(refrozen.caseHash).toBe(hashCase(CASE)); // …and the stamp survived the round-trip

      // And the next run replays the healed skill instead of re-discovering, and passes on it:
      // a judged replay has assertion results; the crashed/re-discover paths don't.
      const second = await runSuite([CASE], {
        store,
        driverFactory: shopDriver,
        llm: forbiddenLlm,
        heal: false,
        reporter,
      });
      expect(second.verdicts[0]!.discovered).toBe(false);
      expect(second.verdicts[0]!.verdict.results.length).toBeGreaterThan(0);
      expect(second.verdicts[0]!.verdict.passed).toBe(true);
      expect(second.usage.llmCalls).toBe(0);

      // The real reporter wrote a parseable Result for the healed replay.
      const reported = JSON.parse(await readFile(join(dir, "result.json"), "utf8")) as {
        verdict: { passed: boolean };
      };
      expect(reported.verdict.passed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a repointed case url as stale — re-discovers instead of replaying against the old target (#131)", async () => {
    const store = new MemoryStore();
    // Frozen when the case pointed at the OLD shop — the skill's first goto still goes there.
    store.skills.set(REF, withCaseHash(frozen, CASE));

    // The user repoints ONLY the url; intent and criteria are untouched.
    const moved: SuiteCase = { ...CASE, url: "https://other-shop/" };

    const driverFactory = (): StubDriver => {
      const d = new StubDriver("https://other-shop/");
      d.els = [{ role: "link", name: "Products" }];
      d.navOn["Products"] = "https://other-shop/products";
      return d;
    };
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Products","reason":"open catalog"}',
      '{"action":"done"}',
      "[]",
    ]);

    const suite = await runSuite([moved], { store, driverFactory, llm, reporter: silent });

    // The old skill must not replay against the new target — discovery ran on the new url.
    expect(suite.verdicts[0]!.discovered).toBe(true);
    const refrozen = store.skills.get(REF) as Scenario & { caseHash?: string };
    expect(refrozen.steps[0]).toMatchObject({ kind: "goto", url: "https://other-shop/" });
    expect(refrozen.caseHash).toBe(hashCase(moved));
  });

  it("treats a changed suite baseUrl as stale for a url-less case — the frozen goto came from it (#131)", async () => {
    const store = new MemoryStore();
    const bare: SuiteCase = { id: "catalog", intent: "open the catalog" }; // start url = suite baseUrl
    store.skills.set(REF, { ...frozen, caseHash: hashCase(bare, "https://shop/") } as Scenario);

    // Control: with the ORIGINAL baseUrl the same store is a clean hit — proving the url is the
    // only variable in the stale run below (and a hit replays mechanically: the LLM stays cold).
    const control = await runSuite([bare], {
      store,
      driverFactory: shopDriver,
      llm: forbiddenLlm,
      reporter: silent,
      baseUrl: "https://shop/",
    });
    expect(control.verdicts[0]!.discovered).toBe(false);

    const driverFactory = (): StubDriver => {
      const d = new StubDriver("https://other-shop/");
      d.els = [{ role: "link", name: "Products" }];
      d.navOn["Products"] = "https://other-shop/products";
      return d;
    };
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Products","reason":"open catalog"}',
      '{"action":"done"}',
      "[]",
    ]);

    const suite = await runSuite([bare], {
      store,
      driverFactory,
      llm,
      reporter: silent,
      baseUrl: "https://other-shop/",
    });

    expect(suite.verdicts[0]!.discovered).toBe(true);
    expect((store.skills.get(REF) as Scenario).steps[0]).toMatchObject({ url: "https://other-shop/" });
  });

  it("treats a cache hit with a stale caseHash as a miss — re-discovers instead of trusting drifted criteria", async () => {
    const store = new MemoryStore();
    // Frozen under an OLD version of the case (no `expect`) — its caseHash reflects that old shape.
    const oldCase: SuiteCase = { id: "catalog", intent: "open the catalog", url: "https://shop/" };
    store.skills.set(REF, withCaseHash(frozen, oldCase));

    // The case now carries the user's success criterion — a real edit to cases.json.
    const newCase: SuiteCase = { ...oldCase, expect: ["the catalog page lists products"] };

    const llm = new ScriptedLlm([
      '{"action":"click","text":"Products","reason":"open catalog"}',
      '{"action":"done"}',
      "[]", // discover's assertion proposal
      '{"passed":true,"detail":"catalog reached"}', // LlmCritic judging the user's new expect
    ]);

    const suite = await runSuite([newCase], { store, driverFactory: shopDriver, llm, reporter: silent });

    // A stale cache must NOT be trusted — the LLM had to run (discover + judge), proving the
    // engine did not silently replay the old skill against the new criteria.
    expect(suite.verdicts[0]).toMatchObject({ discovered: true, verdict: { passed: true } });
    expect(suite.usage.llmCalls).toBeGreaterThan(0);

    // The re-frozen skill's hash now matches the NEW case, so the next unchanged run is a clean hit.
    const refrozen = store.skills.get(REF) as Scenario & { caseHash?: string };
    expect(refrozen.caseHash).toBe(hashCase(newCase));
    expect(refrozen.assertions).toEqual(
      expect.arrayContaining([{ kind: "expect", criterion: "the catalog page lists products", origin: "user" }]),
    );
  });

  it("preserves the user-merged assertion through a step-heal re-freeze", async () => {
    const store = new MemoryStore();
    const checkoutCase: SuiteCase = {
      id: "checkout",
      intent: "buy the item",
      url: "https://app/start",
      expect: ["the user reaches the payment page"],
    };
    const checkoutRef = "skills/checkout.skill.json";
    const checkoutSkill: FrozenSuiteScenario = {
      name: "checkout",
      steps: [
        {
          kind: "click",
          target: { text: "Checkout" },
          intent: "go to payment",
          expect: { url: "app/payment" },
        },
      ],
      assertions: [
        { kind: "navigated" },
        { kind: "expect", criterion: "the user reaches the payment page" },
      ],
      caseHash: hashCase(checkoutCase), // must match after Fix 1, else this misfires into rediscovery
    };
    store.skills.set(checkoutRef, checkoutSkill);
    const driverFactory = (): StubDriver => {
      const d = new StubDriver();
      d.els = [{ role: "button", name: "Checkout Now" }];
      d.navOn["Checkout Now"] = "https://app/payment";
      return d;
    };
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Checkout Now"}', // surgical heal for the diverged step
      '{"passed":true,"detail":"reached the payment page"}', // LlmCritic judging the expect
    ]);

    const suite = await runSuite([checkoutCase], {
      store,
      driverFactory,
      llm,
      reporter: silent,
      expectTimeoutMs: 50,
    });

    expect(suite.verdicts[0]).toMatchObject({ discovered: false, verdict: { passed: true }, heals: 1 });
    const refrozen = store.skills.get(checkoutRef)!;
    expect(refrozen.assertions).toEqual(
      expect.arrayContaining([{ kind: "expect", criterion: "the user reaches the payment page" }]),
    );
  });

  it("a crashing case fails closed without killing the rest of the suite", async () => {
    const store = new MemoryStore();
    store.skills.set("skills/ok.skill.json", frozen);
    let calls = 0;
    const driverFactory = (): StubDriver => {
      calls++;
      if (calls === 1) {
        const d = new StubDriver();
        d.goto = async () => {
          throw new Error("browser died");
        };
        return d;
      }
      return shopDriver();
    };

    const suite = await runSuite(
      [
        { id: "boom", intent: "explode", url: "https://shop/" },
        { id: "ok", intent: "open the catalog", url: "https://shop/" },
      ],
      // The ok case is a cache miss (no caseHash) → it re-discovers; the replies make that
      // discovery a real navigation, so its freeze isn't all-vacuous (#137 would fail it closed).
      {
        store,
        driverFactory,
        llm: new ScriptedLlm(['{"action":"click","text":"Products"}', '{"action":"done"}', "[]"]),
        reporter: silent,
      },
    );

    expect(suite.passed).toBe(false);
    expect(suite.verdicts[0]!.verdict.detail).toContain("browser died");
    expect(suite.verdicts[1]!.verdict.passed).toBe(true); // the suite carried on
  });

  it("rejects bad config up front — before any browser or LLM spend", async () => {
    const opts = { store: new MemoryStore(), driverFactory: shopDriver, llm: forbiddenLlm };
    await expect(runSuite([], opts)).rejects.toThrow("empty");
    await expect(runSuite([{ id: "a/b", intent: "x", url: "u" }], opts)).rejects.toThrow("path");
    await expect(
      runSuite(
        [
          { id: "a", intent: "x", url: "u" },
          { id: "a", intent: "y", url: "u" },
        ],
        opts,
      ),
    ).rejects.toThrow("duplicate");
    await expect(runSuite([{ id: "a", intent: "x" }], opts)).rejects.toThrow("no url");
    await expect(runSuite([{ id: "a", intent: "" , url: "u" }], opts)).rejects.toThrow("intent");
  });
});

describe("runSuite trace", () => {
  class RecordingSink {
    events: TraceEvent[] = [];
    emit(e: TraceEvent): void {
      this.events.push(e);
    }
  }
  const kinds = (sink: RecordingSink): string[] => sink.events.map((e) => `${e.phase ?? "-"}:${e.kind}`);

  it("emits the contract stream on a cache miss: header → case events (discover then replay) → run-end", async () => {
    const sink = new RecordingSink();
    const store = new MemoryStore();
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Products","reason":"open catalog"}',
      '{"action":"done","assertions":[{"kind":"navigated"}]}',
      "[]",
    ]);

    await runSuite([CASE], { store, driverFactory: shopDriver, llm, reporter: silent, trace: sink });

    const seqs = sink.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(sink.events[0]!.kind).toBe("trace");
    const ks = kinds(sink);
    expect(ks[1]).toBe("-:case-start");
    expect(ks).toContain("discover:action");
    expect(ks).toContain("discover:freeze");
    expect(ks).toContain("replay:step");
    expect(ks).toContain("replay:assertion");
    expect(ks.at(-2)).toBe("-:case-end");
    expect(ks.at(-1)).toBe("-:run-end");
    // Flat correlation: every case-scoped event carries the case id; header/run-end carry none.
    for (const e of sink.events.slice(1, -1)) expect(e.caseRef).toBe(CASE.id);
    expect(sink.events[0]!.caseRef).toBeUndefined();
    expect(sink.events.at(-1)!.caseRef).toBeUndefined();

    const caseStart = sink.events[1]!;
    expect(caseStart.payload).toMatchObject({ id: CASE.id, intent: CASE.intent, skillRef: REF, cached: false });
    const freeze = sink.events.find((e) => e.kind === "freeze")!;
    expect(freeze.payload).toMatchObject({ ref: REF, assertions: { user: 0, unknown: 0 } });
    expect((freeze.payload as { caseHash: string }).caseHash).toHaveLength(64);
    expect((freeze.payload as { assertions: { derived: number } }).assertions.derived).toBeGreaterThan(0);
    const caseEnd = sink.events.at(-2)!;
    expect(caseEnd.payload).toMatchObject({ discovered: true, heals: 0, verdict: { passed: true } });
    const runEnd = sink.events.at(-1)!;
    expect(runEnd.payload).toMatchObject({ passed: true });
  });

  it("a cached replay marks case-start cached:true and emits no discover-phase events", async () => {
    const sink = new RecordingSink();
    const store = new MemoryStore();
    store.skills.set(REF, withCaseHash(frozen, CASE));

    await runSuite([CASE], { store, driverFactory: shopDriver, llm: forbiddenLlm, reporter: silent, trace: sink });

    expect(sink.events[1]!.payload).toMatchObject({ cached: true });
    expect(sink.events.some((e) => e.phase === "discover")).toBe(false);
  });

  it("the freeze payload names an unproven action next to truncated (#190)", async () => {
    const sink = new RecordingSink();
    const store = new MemoryStore();
    const { driverFactory } = unprovenShop();
    const llm = new ScriptedLlm(['{"action":"click","text":"Products"}', '{"action":"done"}', "[]"]);

    await runSuite([CASE], { store, driverFactory, llm, reporter: silent, trace: sink });

    const freeze = sink.events.find((e) => e.kind === "freeze")!;
    expect(freeze.payload).toMatchObject({ ref: REF, unprovenAction: "DELETE https://shop/586738" });
    expect((freeze.payload as { truncated?: boolean }).truncated).toBeUndefined();
  });

  it("the outcome-heal re-freeze emits a freeze event under phase heal, caseHash re-stamped", async () => {
    const sink = new RecordingSink();
    const store = new MemoryStore();
    // Frozen with a step that goes nowhere — replay fails, outcome-heal runs and reaches the goal,
    // so the repair is handed back and re-frozen (a heal that missed the goal would not be, #186).
    const stale: FrozenSuiteScenario = {
      ...frozen,
      steps: [{ kind: "goto", url: "https://shop/" }, { kind: "click", target: { text: "Catalog" } }],
      assertions: [{ kind: "navigated", to: "shop/products" }],
      caseHash: hashCase(CASE),
    };
    store.skills.set(REF, stale);
    const llm = new ScriptedLlm(['{"action":"click","text":"Products"}', '{"action":"done"}', "[]"]);

    await runSuite([CASE], { store, driverFactory: shopDriver, llm, reporter: silent, trace: sink });

    const freezes = sink.events.filter((e) => e.kind === "freeze");
    expect(freezes).toHaveLength(1); // cache hit → no discover freeze; only the heal re-freeze
    expect(freezes[0]).toMatchObject({ phase: "heal" });
    expect((freezes[0]!.payload as { caseHash: string }).caseHash).toBe(hashCase(CASE));
    // The re-discovery's own events rode out under phase heal (kinds say what, phase says why).
    expect(kinds(sink)).toContain("heal:action");
  });
});

describe("renderSuiteReport", () => {
  it("renders the verdict table, the zero-LLM headline, and failure details", () => {
    const md = renderSuiteReport({
      passed: false,
      usage: { llmCalls: 3, measuredCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      verdicts: [
        {
          id: "catalog",
          intent: "open the catalog",
          skillRef: "skills/catalog.skill.json",
          discovered: false,
          heals: 0,
          usage: { llmCalls: 0, measuredCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
          verdict: { passed: true, results: [] },
        },
        {
          id: "checkout",
          intent: "buy a bag of beans",
          skillRef: "skills/checkout.skill.json",
          discovered: true,
          heals: 0,
          usage: { llmCalls: 3, measuredCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
          verdict: {
            passed: false,
            results: [
              {
                assertion: { kind: "request-status", urlIncludes: "api/pay", status: 200 },
                passed: false,
                detail: "no request matching api/pay",
              },
            ],
          },
        },
      ],
    });

    expect(md).toContain("1/2 case(s) passed");
    expect(md).toContain("1 case(s) replayed with zero LLM calls");
    expect(md).toContain("| catalog | ✓ pass | replayed (cached) |");
    expect(md).toContain("| checkout | ✗ fail | discovered + replayed |");
    expect(md).toContain("### ✗ checkout — buy a bag of beans");
    expect(md).toContain("**request-status**: no request matching api/pay");
  });
});

describe("a truncated outcome-heal re-discovery is not frozen (#186)", () => {
  it("leaves the stale skill in the store and reports the truncated verdict", async () => {
    const store = new MemoryStore();
    // The stale click goes nowhere, so replay misses shop/products and outcome-heal runs. The
    // re-discovery's very first click DOES reach shop/products — so the only thing withholding the
    // repair below is that the loop never said `done` and ran to the cap (truncation alone).
    const stale: FrozenSuiteScenario = {
      name: "checkout",
      steps: [{ kind: "goto", url: "https://shop/" }, { kind: "click", target: { text: "Catalog" } }],
      assertions: [{ kind: "navigated", to: "shop/products" }],
      caseHash: hashCase(CASE),
    };
    store.skills.set(REF, stale);
    let calls = 0;
    const llm: LlmClient = { id: "always-click", async complete() { calls += 1; return '{"action":"click","text":"Products"}'; } };
    const events: TraceEvent[] = [];
    const sink = { emit: (e: TraceEvent) => { events.push(e); } };

    const suite = await runSuite([{ ...CASE, id: "catalog", maxSteps: 4 }], { store, driverFactory: shopDriver, llm, reporter: silent, trace: sink });

    const v = suite.verdicts[0]!;
    expect(v.verdict.results.find((r) => r.assertion.kind === "navigated")?.passed).toBe(true); // goal held on the partial state
    expect(v.verdict.passed).toBe(false);
    expect(v.truncated).toBe(true); // structured, like a truncated first discovery…
    expect(events.find((e) => e.kind === "case-end")?.payload).toMatchObject({ truncated: true }); // …on the trace too
    expect(v.verdict.detail).toMatch(/unverified path/);
    expect(store.skills.get(REF)).toBe(stale); // not re-frozen: the next run must not replay a capped path
    expect(calls).toBeLessThan(8); // the case's maxSteps (4) reached the heal, not the default 20
  });
});

import { runScenario } from "../src/run.js";
import { FakeDriver } from "../src/adapters/drivers/fake.js";
import type { Evidence } from "../src/index.js";

// Consolidated audit coverage.

{

  class MemoryStore implements SkillStore {
    readonly skills = new Map<string, Scenario>();
    async load(ref: string): Promise<Scenario> {
      const s = this.skills.get(ref);
      if (!s) throw new Error(`missing skill: ${ref}`);
      return s;
    }
    async freeze(ref: string, scenario: Scenario): Promise<string> {
      this.skills.set(ref, scenario);
      return ref;
    }
  }

  const forbiddenLlm: LlmClient = { id: "forbidden", complete: async () => { throw new Error("no LLM"); } };

  const silent: Reporter = { emit: async () => {} };

  const frozen: Scenario = {
    name: "open the catalog",
    steps: [{ kind: "goto", url: "https://shop/" }, { kind: "click", target: { text: "Products" } }],
    assertions: [{ kind: "navigated" }],
  };

  const CASE: SuiteCase = { id: "catalog", intent: "open the catalog", url: "https://shop/" };

  const shopDriver = (): StubDriver => {
    const d = new StubDriver("https://shop/");
    d.els = [{ role: "link", name: "Products" }];
    d.navOn["Products"] = "https://shop/products";
    return d;
  };

  // suite-abort-rethrows.test.ts
  {
    it("suiteAbortRethrows: an aborted signal stops the suite with the abort error — later cases are never started, not marked crashed", async () => {
      const a: SuiteCase = { id: "a", intent: "open the catalog", url: "https://shop/" };
      const b: SuiteCase = { id: "b", intent: "open the catalog", url: "https://shop/" };
      const store = new MemoryStore();
      store.skills.set("skills/a.skill.json", { ...frozen, caseHash: hashCase(a) } as Scenario);
      store.skills.set("skills/b.skill.json", { ...frozen, caseHash: hashCase(b) } as Scenario);
      const ac = new AbortController();
      ac.abort();
      let built = 0;
      const seen: string[] = [];
      const driverFactory = (): StubDriver => (built++, new StubDriver("https://shop/"));

      await expect(
        runSuite([a, b], { store, driverFactory, llm: forbiddenLlm, reporter: silent, signal: ac.signal, onCase: (v) => seen.push(v.id) }),
      ).rejects.toThrow();
      expect(seen).toEqual([]); // no "crashed" verdict was minted for either case
      expect(built).toBe(1); // case b never even got a driver
    });
  }

  // suite-case-end-heals-excludes-outcome-heal.test.ts
  {
    it("caseEndHealsExcludesOutcomeHeal: an outcome-heal (re-discovery) is NOT counted in case-end.heals — suite and bare run alike", async () => {
      // Suite: cached skill whose assertion the stub can never satisfy → outcome-heal runs.
      const events: TraceEvent[] = [];
      const store = new MemoryStore();
      const failing: FrozenSuiteScenario = {
        name: "open the catalog",
        steps: [{ kind: "goto", url: "https://shop/" }, { kind: "click", target: { text: "Products" } }],
        assertions: [{ kind: "request-status", urlIncludes: "/api/orders", status: 200 }],
        caseHash: hashCase(CASE),
      };
      store.skills.set("skills/catalog.skill.json", failing);
      const suite = await runSuite([CASE], {
        store, driverFactory: shopDriver, llm: new ScriptedLlm(['{"action":"done"}', "[]"]),
        reporter: silent, trace: { emit: (e) => events.push(e) },
      });
      expect(events.some((e) => e.phase === "heal" && e.kind === "action")).toBe(true); // the re-discovery ran
      const caseEnd = events.find((e) => e.kind === "case-end")!;
      expect(caseEnd.payload).toMatchObject({ heals: 0, discovered: false });
      expect(suite.verdicts[0]!.heals).toBe(0);

      // Bare run: same rule on run.ts's own outcome-heal return path.
      const bare: TraceEvent[] = [];
      const evidence: Evidence = {
        execution: { actions: [], navigated: true, finalUrl: "https://iana.org", blocked: false },
        perception: {},
        logic: { requests: [], console: [] },
      };
      await runScenario(
        { name: "reach the moon", steps: [{ kind: "goto", url: "https://example.com" }], assertions: [{ kind: "navigated", to: "the-moon" }] },
        { driver: new FakeDriver({ evidence, elements: [] }), llm: new ScriptedLlm(['{"action":"done"}', "[]"]), heal: true, reporter: silent, trace: { emit: (e) => bare.push(e) } },
      );
      expect(bare.some((e) => e.phase === "heal")).toBe(true);
      expect(bare.find((e) => e.kind === "case-end")!.payload).toMatchObject({ heals: 0 });
    });
  }

  // suite-crashed-case-ends-trace.test.ts
  {
    it("suiteCrashedCaseEndsTrace: a crashed case still emits case-end (failed verdict, heals 0, no phase) and run-end says passed:false", async () => {
      const boom: SuiteCase = { id: "boom", intent: "open the catalog", url: "https://shop/" };
      const store = new MemoryStore();
      store.skills.set("skills/boom.skill.json", { ...frozen, caseHash: hashCase(boom) } as Scenario);
      const driverFactory = (): StubDriver => {
        const d = new StubDriver("https://shop/");
        d.goto = async () => { throw new Error("browser died"); };
        return d;
      };
      const events: TraceEvent[] = [];
      await runSuite([boom], { store, driverFactory, llm: forbiddenLlm, reporter: silent, trace: { emit: (e) => events.push(e) } });
      const end = events.find((e) => e.kind === "case-end")!;
      expect(end.caseRef).toBe("boom");
      expect(end.phase).toBeUndefined();
      expect(end.payload).toMatchObject({ heals: 0, discovered: false, verdict: { passed: false } });
      expect((end.payload as { verdict: { detail?: string } }).verdict.detail).toContain("browser died");
      expect(events.at(-1)).toMatchObject({ kind: "run-end", payload: { passed: false } });
    });
  }

  // suite-freeze-counts-user-criteria.test.ts
  {
    it("suiteFreezeCountsUserCriteria: the discover freeze event counts merged user expect + assertions under `user`, derived separately, unknown 0", async () => {
      const events: TraceEvent[] = [];
      const llm = new ScriptedLlm([
        '{"action":"click","text":"Products","reason":"open catalog"}',
        '{"action":"done"}',
        "[]",
        '{"passed":true,"detail":"ok"}', // LlmCritic judging the user's expect at replay
      ]);
      await runSuite(
        [{ id: "catalog", intent: "open the catalog", url: "https://shop/",
           expect: ["the catalog page lists products"],
           assertions: [{ kind: "navigated", to: "shop/products" }] }],
        { store: new MemoryStore(), driverFactory: shopDriver, llm, reporter: silent, trace: { emit: (e) => events.push(e) } },
      );
      const freeze = events.find((e) => e.kind === "freeze")!;
      expect(freeze.phase).toBe("discover");
      const counts = (freeze.payload as { assertions: { user: number; derived: number; unknown: number } }).assertions;
      expect(counts.user).toBe(2);
      expect(counts.unknown).toBe(0);
      expect(counts.derived).toBeGreaterThan(0);
    });
  }

  // suite-hash-case-ignores-id-and-max-steps.test.ts
  {
    it("hashCaseIgnoresIdAndMaxSteps: only intent/url/expect/assertions fingerprint a case — id and maxSteps are not what was discovered", () => {
      const c = { id: "a", intent: "open the catalog", url: "https://shop/", expect: ["lists products"] };
      expect(hashCase({ ...c, id: "renamed", maxSteps: 12 })).toBe(hashCase(c));
      expect(hashCase({ ...c, intent: "open the cart" })).not.toBe(hashCase(c));
      expect(hashCase({ ...c, expect: [] })).not.toBe(hashCase(c));
      expect(hashCase({ ...c, url: undefined }, "https://shop/")).toBe(hashCase(c)); // baseUrl fallback = same start
    });
  }

  // suite-rejects-dot-dot-id.test.ts
  {
    const store: SkillStore = {
      load: async () => { throw new Error("must not load"); },
      freeze: async () => { throw new Error("must not freeze"); },
    };

    it("suiteRejectsDotDotId: a case id of `..` (no slash) is still rejected as a path escape, before any spend", async () => {
      const opts = { store, driverFactory: () => new StubDriver(), llm: forbiddenLlm };
      await expect(runSuite([{ id: "..", intent: "x", url: "u" }], opts)).rejects.toThrow("path");
      await expect(runSuite([{ id: "a..b", intent: "x", url: "u" }], opts)).rejects.toThrow("path");
    });
  }

  // suite-seq-shared-across-cases.test.ts
  {
    it("suiteSeqSharedAcrossCases: one trace, one seq counter — two cases produce one contiguous 0..n-1 sequence, each event tagged with its own caseRef", async () => {
      const a: SuiteCase = { id: "a", intent: "open the catalog", url: "https://shop/" };
      const b: SuiteCase = { id: "b", intent: "open the catalog", url: "https://shop/" };
      const store = new MemoryStore();
      store.skills.set("skills/a.skill.json", { ...frozen, caseHash: hashCase(a) } as Scenario);
      store.skills.set("skills/b.skill.json", { ...frozen, caseHash: hashCase(b) } as Scenario);
      const events: TraceEvent[] = [];
      const suite = await runSuite([a, b], { store, driverFactory: shopDriver, llm: forbiddenLlm, reporter: silent, trace: { emit: (e) => events.push(e) } });

      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
      expect(events.filter((e) => e.kind === "trace")).toHaveLength(1);
      expect(events.filter((e) => e.kind === "case-start").map((e) => e.caseRef)).toEqual(["a", "b"]);
      const iA = events.findIndex((e) => e.kind === "case-end" && e.caseRef === "a");
      const iB = events.findIndex((e) => e.kind === "case-start" && e.caseRef === "b");
      expect(iA).toBeLessThan(iB); // cases are sequential, not interleaved
      expect(events.at(-1)!.payload).toMatchObject({ passed: true, usage: suite.usage });
    });
  }

  // suite-skill-dir-prefixes-ref.test.ts
  {
    const frozen: Scenario = {
      name: "open the catalog",
      steps: [{ kind: "goto", url: "https://shop/" }],
      assertions: [{ kind: "navigated" }],
    };

    it("suiteSkillDirPrefixesRef: skillDir names the store ref for load and freeze alike, and the same ref rides on skillRef and case-start", async () => {
      const c: SuiteCase = { id: "catalog", intent: "open the catalog", url: "https://shop/" };
      const loaded: string[] = [];
      const store: SkillStore = {
        load: async (ref) => { loaded.push(ref); return { ...frozen, caseHash: hashCase(c) } as Scenario; },
        freeze: async () => { throw new Error("cache hit must not freeze"); },
      };
      const events: TraceEvent[] = [];
      const suite = await runSuite([c], {
        store, skillDir: "qa/frozen", driverFactory: () => new StubDriver("https://shop/"), llm: forbiddenLlm, reporter: silent, trace: { emit: (e) => events.push(e) },
      });
      expect(loaded).toEqual(["qa/frozen/catalog.skill.json"]);
      expect(suite.verdicts[0]!.skillRef).toBe("qa/frozen/catalog.skill.json");
      expect(events.find((e) => e.kind === "case-start")!.payload).toMatchObject({ skillRef: "qa/frozen/catalog.skill.json", cached: true });
    });
  }

}
