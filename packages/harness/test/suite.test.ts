import { describe, expect, it } from "vitest";
import { runSuite, hashCase } from "../src/suite.js";
import type { FrozenSuiteScenario, SuiteCase } from "../src/suite.js";
import { renderSuiteReport } from "../src/adapters/reporters/suite.js";
import { ScriptedLlm, StubDriver } from "./support/doubles.js";
import type { LlmClient, Reporter, Scenario, SkillStore } from "../src/index.js";

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
        { kind: "navigated", to: "shop/products" },
        { kind: "expect", criterion: "the catalog page lists products" },
      ]),
    );
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
      expect.arrayContaining([{ kind: "expect", criterion: "the catalog page lists products" }]),
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
      { store, driverFactory, llm: new ScriptedLlm([]), reporter: silent },
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
