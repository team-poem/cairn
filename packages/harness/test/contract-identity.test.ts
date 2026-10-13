import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identifyScenario, scenarioContract, compareContracts, hashContractValue } from "../src/core/contract.js";
import { runScenario } from "../src/run.js";
import { runSuite, hashCase } from "../src/suite.js";
import { discover } from "../src/core/discover/index.js";
import { AssertionCritic } from "../src/adapters/critics/assertion.js";
import { loadSkillFile, saveSkillFile } from "../src/adapters/skills/file-store.js";
import { ScriptedLlm, StubDriver } from "./support/doubles.js";
import type { Scenario, SkillStore, TraceEvent, Result } from "../src/index.js";
import * as browser from "../src/browser.js";
import * as node from "../src/index.js";

const silent = { emit: async () => {} };
const base = (): Scenario => ({
  name: "display label",
  steps: [{ kind: "goto", url: "https://shop/cart" }],
  assertions: [{ kind: "navigated", to: "shop/cart" }],
});
const stamp = () => identifyScenario(base(), { intent: "open cart" });

describe("contract canonicalization", () => {
  it("uses UTF-8 SHA-256 with stable nested object keys", async () => {
    const value = { b: { z: 3, a: 2 }, a: [1, 2] };
    const expected = createHash("sha256").update('{"a":[1,2],"b":{"a":2,"z":3}}').digest("hex");
    expect(await hashContractValue(value)).toBe(expected);
    expect(await hashContractValue({ a: [1, 2], b: { a: 2, z: 3 }, missing: undefined })).toBe(expected);
    expect(await hashContractValue([1, 2])).not.toBe(await hashContractValue([2, 1]));
    expect(await hashContractValue("\u{1f30d}")).toBe(createHash("sha256").update(JSON.stringify("\u{1f30d}")).digest("hex"));
  });

  it.each([NaN, Infinity, BigInt(2), () => 1, new Date(), [undefined], new Array(1)])("rejects non-JSON material (%s)", async value => {
    await expect(hashContractValue(value)).rejects.toThrow("Contract inputs");
  });

  it("rejects cycles but permits shared non-cyclic values", async () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    await expect(hashContractValue(cycle)).rejects.toThrow("Contract inputs");
    const common = { x: 1 };
    expect(await hashContractValue([common, common])).toBe(await hashContractValue([{ x: 1 }, { x: 1 }]));
  });

  it("changes for assertions, intent, vacuity and wildcard semantics", async () => {
    const s = await stamp();
    for (const changed of [
      { ...s, assertions: [...s.assertions, { kind: "no-console-errors" as const }] },
      { ...s, assertions: [{ ...s.assertions[0]!, vacuous: true as const }] },
      { ...s, wildcards: true as const },
    ]) expect(compareContracts(s.contract, await scenarioContract(changed))).toBe("changed");
    expect(compareContracts(s.contract, await scenarioContract(s, { intent: "buy cart" }))).toBe("changed");
  });

  it("excludes label, execution path, runtime limits and context provenance", async () => {
    const s = await stamp();
    const a = await identifyScenario({ ...s, name: "renamed", steps: [], maxSteps: 1 }, {
      provenance: { appContextHash: await hashContractValue("first description") },
    });
    const b = await identifyScenario(a, { provenance: { appContextHash: await hashContractValue("second description") } });
    expect(compareContracts(s.contract, a.contract)).toBe("same");
    expect(compareContracts(a.contract, b.contract)).toBe("same");
    expect(a.provenance).not.toEqual(b.provenance);
    expect(s.provenance).toBeUndefined();
    expect(JSON.stringify(b)).not.toContain("second description");
  });

  it("canonicalizes judgment sets and includes semantic options", async () => {
    const s = await stamp();
    const a = await scenarioContract(s, { benign: ["b", "a", "a"] });
    const b = await scenarioContract(s, { benign: ["a", "b"] });
    expect(compareContracts(a, b)).toBe("same");
    for (const opts of [{ benign: ["noise"] }, { benignConsole: ["warning"] }, { localePrefixes: [] },
      { requestMatch: { allowedHosts: ["api.shop"] } }, { judgmentKey: "checks-v2" }]) {
      expect(compareContracts(s.contract, await scenarioContract(s, opts))).toBe("changed");
    }
    expect(compareContracts(s.contract, await scenarioContract(s, { localePrefixes: ["jp", "ko", "ja", "en"] }))).toBe("same");
  });

  it("does not infer authoring intent from legacy display names or future metadata", async () => {
    const legacy = await scenarioContract(base());
    expect(legacy.complete).toBe(false);
    expect(compareContracts(legacy, legacy)).toBe("unknown");
    const s = await stamp();
    for (const unknown of [undefined, null, {}, { ...s.contract, version: 2 }, { ...s.contract, fingerprint: "invalid" }]) {
      expect(compareContracts(s.contract, unknown)).toBe("unknown");
    }
  });

  it("requires a host key for custom and semantic checks or opaque critics", async () => {
    const s = await stamp();
    for (const assertion of [{ kind: "custom" as const, name: "quantity" }, { kind: "expect" as const, criterion: "cart filled" }]) {
      const custom = { ...s, assertions: [assertion] };
      const unknown = await scenarioContract(custom);
      expect(compareContracts(unknown, unknown)).toBe("unknown");
      const v1 = await scenarioContract(custom, { judgmentKey: "quantity-v1", judgmentIntent: null });
      const v2 = await scenarioContract(custom, { judgmentKey: "quantity-v2", judgmentIntent: null });
      expect(compareContracts(v1, v1)).toBe("same");
      expect(compareContracts(v1, v2)).toBe("changed");
    }
    expect((await scenarioContract(s, { opaque: true })).complete).toBe(false);
  });

  it("distinguishes unknown effective intent from known absence without exposing raw intent", async () => {
    const s = await identifyScenario({ ...base(), assertions: [{ kind: "expect", criterion: "matches intent" }] }, { intent: "authoring" });
    const options = { judgmentKey: "judge-v1" };
    expect((await scenarioContract(s, options)).complete).toBe(false);
    const absent = await scenarioContract(s, { ...options, judgmentIntent: null });
    const present = await scenarioContract(s, { ...options, judgmentIntent: "private judging intent" });
    expect(compareContracts(absent, present)).toBe("changed");
    expect(present.intentHash).toBe(s.contract.intentHash);
    expect(JSON.stringify(present)).not.toContain("private judging intent");
    expect(await browser.scenarioContract(s, { ...options, judgmentIntent: null })).toEqual(absent);
  });
});

describe("contract identity on engine paths", () => {
  it.each([undefined, {}, { subtle: {} }])("preserves traceless execution without a digest API (%s)", async crypto => {
    const frozen = await stamp();
    const previous = JSON.stringify(frozen);
    vi.stubGlobal("crypto", crypto);
    try {
      for (const scenario of [base(), frozen]) {
        const driver = new StubDriver();
        const goto = vi.spyOn(driver, "goto");
        const result = await browser.runHarness({ context: new browser.InlineContextProvider(),
          planner: new browser.StaticPlanner(scenario), driver, critic: new browser.AssertionCritic(), reporter: silent,
        }, "open cart");
        expect(result.verdict.passed).toBe(true);
        expect(goto).toHaveBeenCalledOnce();
        expect(result.verdict.contract?.complete).toBe(false);
        expect(compareContracts(frozen.contract, result.verdict.contract)).toBe("unknown");
        const run = await runScenario(scenario, { driver: new StubDriver(), reporter: silent });
        expect(run.result.verdict.passed).toBe(true);
        expect(run.result.usage?.llmCalls).toBe(0);
        expect(run.result.verdict.contract?.complete).toBe(false);
      }
      expect(JSON.stringify(frozen)).toBe(previous);
      expect((await scenarioContract(frozen)).intentHash).toBe(frozen.contract.intentHash);
      // Explicit re-authoring must not retain the old intent hash when the new intent cannot be hashed.
      const authored = await identifyScenario(frozen, { intent: "different intent" });
      expect(authored.contract.complete).toBe(false);
      expect(authored.contract.intentHash).toBeUndefined();
      const semantic = await scenarioContract({ ...frozen, assertions: [{ kind: "expect", criterion: "done" }] },
        { judgmentIntent: "new judging intent", judgmentKey: "judge-v1" });
      expect(semantic.complete).toBe(false);
      const custom = await identifyScenario({ ...base(), assertions: [{ kind: "custom", name: "proof", params: { n: 1n } }] },
        { intent: "new intent" });
      expect(custom.contract.complete).toBe(false); // No recursive hashing in an unavailable fallback.
      await expect(hashContractValue("explicit request")).rejects.toThrow("WebCrypto SHA-256 is unavailable");
    } finally { vi.unstubAllGlobals(); }
    expect(compareContracts(frozen.contract, await scenarioContract(frozen))).toBe("same");
  });

  it("distinguishes the effective semantic intent without changing authoring identity", async () => {
    const s = await identifyScenario({ ...base(), name: "approve", assertions: [{ kind: "expect", criterion: "matches intent" }] },
      { intent: "original intent", judgmentKey: "judge-v1" });
    const llm = { id: "fixed", complete: async (prompt: string) => JSON.stringify({ passed: prompt.startsWith("Task intent: approve\n") }) };
    const run = async (name: string, intent?: string) => (await runScenario({ ...s, name }, {
      driver: new StubDriver(), reporter: silent, judgmentKey: "judge-v1", llm,
      ...(intent === undefined ? {} : { context: { provide: async () => ({ intent }) } }),
    })).result.verdict;
    const approved = await run("approve");
    const denied = await run("deny");
    expect([approved.passed, denied.passed]).toEqual([true, false]);
    expect(compareContracts(approved.contract, denied.contract)).toBe("changed");
    expect(compareContracts(approved.contract, (await run("renamed", "approve")).contract)).toBe("same");
    expect(compareContracts(approved.contract, (await run("approve", "deny")).contract)).toBe("changed");
    expect(denied.contract?.intentHash).toBe(s.contract.intentHash);
    expect(s.contract.complete).toBe(false); // A freeze has not supplied effective judging context.
  });

  it("captures effective intent on the browser runHarness and detects context mutation", async () => {
    const s = await stamp();
    const run = async (intent: string, mutate = false) => {
      const ctx = { intent };
      return browser.runHarness({ context: { provide: async () => ctx }, planner: new browser.StaticPlanner(s),
        driver: new StubDriver(), reporter: silent,
        critic: { judge: async (_e, assertions, context) => {
          const passed = context?.intent === "approve";
          if (mutate) ctx.intent = "changed while judging";
          return { passed, results: assertions.map(assertion => ({ assertion, passed })) };
        } },
      }, "ignored", { judgment: { judgmentKey: "custom-critic-v1" } });
    };
    const a = await run("approve");
    const b = await run("deny");
    expect(compareContracts(a.verdict.contract, b.verdict.contract)).toBe("changed");
    expect((await run("approve", true)).verdict.contract?.complete).toBe(false);
  });

  it.each([new Date("2026-01-01"), BigInt(2), () => true])("replays non-JSON custom params without aborting (%s)", async value => {
    const params = { value };
    const raw: Scenario = { ...base(), assertions: [{ kind: "custom", name: "proof", params }] };
    const custom = { proof: vi.fn(received => received === params) };
    const run = async (s: Scenario) => (await runScenario(s, { driver: new StubDriver(), reporter: silent,
      judgmentKey: "proof-v1", custom })).result.verdict;
    const legacy = await run(raw);
    const identified = await identifyScenario(raw, { intent: "open cart", judgmentKey: "proof-v1" });
    const current = await run(identified);
    expect(legacy.passed).toBe(true);
    expect(current.passed).toBe(true);
    expect(custom.proof).toHaveBeenCalledTimes(2);
    expect(compareContracts(current.contract, current.contract)).toBe("unknown");
    expect(identified.contract.complete).toBe(false);
  });

  it.each([false, true])("does not equate absent and undefined custom params (nested: %s)", async nested => {
    const run = async (present: boolean) => {
      const fields = present ? { threshold: undefined } : {};
      const s = await identifyScenario({ ...base(), assertions: [{ kind: "custom", name: "proof",
        params: nested ? { fields } : fields }] }, { intent: "open cart", judgmentKey: "proof-v1" });
      return (await runScenario(s, { driver: new StubDriver(), reporter: silent, judgmentKey: "proof-v1",
        custom: { proof: params => !Object.hasOwn(nested ? params.fields as object : params, "threshold") },
      })).result.verdict;
    };
    const a = await run(false);
    const b = await run(true);
    expect([a.passed, b.passed]).toEqual([true, false]);
    expect(a.contract?.complete).toBe(true);
    expect(compareContracts(a.contract, b.contract)).toBe("unknown");
  });

  it("keeps cyclic custom params usable through the browser pipeline", async () => {
    const params: Record<string, unknown> = {}; params.self = params;
    const s = await identifyScenario({ ...base(), assertions: [{ kind: "custom", name: "proof", params }] },
      { intent: "open cart", judgmentKey: "proof-v1" });
    const result = await browser.runHarness({ context: new browser.InlineContextProvider(), planner: new browser.StaticPlanner(s),
      driver: new StubDriver(), reporter: silent, critic: new browser.AssertionCritic({ proof: received => received.self === received }),
    }, "open cart", { judgment: { opaque: false, judgmentKey: "proof-v1" } });
    expect(result.verdict.passed).toBe(true);
    expect(compareContracts(s.contract, result.verdict.contract)).toBe("unknown");
  });

  it("does not inspect custom accessors or erase other non-JSON properties", async () => {
    const getter = vi.fn(() => { throw new Error("must not be evaluated by metadata"); });
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    const hidden = Object.defineProperty({}, "value", { value: 1 });
    for (const params of [accessor, hidden, { [Symbol("key")]: 1 }, { value: -0 }, { value: Object.assign([], { extra: 1 }) }]) {
      const s = await identifyScenario({ ...base(), assertions: [{ kind: "custom", name: "proof", params }] },
        { intent: "open cart", judgmentKey: "proof-v1" });
      expect(s.contract.complete).toBe(false);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("captures newly fetched context when judging an outcome repair", async () => {
    const s = await identifyScenario({ ...base(), assertions: [{ kind: "expect", criterion: "matches intent" }] },
      { intent: "original intent", judgmentKey: "judge-v1" });
    const events: TraceEvent[] = [];
    let previous: Result | undefined;
    let contexts = 0;
    const { result, healedScenario } = await runScenario(s, { driver: new StubDriver(), heal: true,
      judgmentKey: "judge-v1", context: { provide: async () => ({ intent: ++contexts === 1 ? "deny" : "approve" }) },
      reporter: { emit: async r => { previous = r; } }, trace: { emit: e => { events.push(e); } },
      llm: { id: "fixed", complete: async prompt => prompt.startsWith("Task intent:")
        ? JSON.stringify({ passed: prompt.startsWith("Task intent: approve\n") }) : '{"action":"done"}' },
    });
    expect(previous?.verdict.passed).toBe(false);
    expect(result.verdict.passed).toBe(true);
    expect(compareContracts(previous?.verdict.contract, result.verdict.contract)).toBe("changed");
    expect(result.verdict.contract?.intentHash).toBe(s.contract.intentHash);
    expect(healedScenario?.contract).toEqual(result.verdict.contract);
    expect(events.find(e => e.kind === "case-end")?.payload).toMatchObject({ verdict: { contract: result.verdict.contract } });
  });

  it("shares the browser/Node helper and replays with no model or description", async () => {
    const s = await browser.identifyScenario(base(), { intent: "open cart" });
    expect(await node.scenarioContract(s)).toEqual(await browser.scenarioContract(s));
    const complete = vi.fn(async () => { throw new Error("No model allowed"); });
    const events: TraceEvent[] = [];
    let reported: Result | undefined;
    const { result } = await runScenario(s, { driver: new StubDriver(), llm: { id: "forbidden", complete },
      trace: { emit: e => { events.push(e); } }, reporter: { emit: async r => { reported = r; } } });
    expect(result.verdict.contract).toEqual(s.contract);
    expect(reported?.verdict.contract).toEqual(s.contract);
    expect(events.find(e => e.kind === "case-end")?.payload).toMatchObject({ verdict: { contract: s.contract } });
    expect(result.usage?.llmCalls).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    const direct = await browser.runHarness({ context: new browser.InlineContextProvider(), planner: new browser.StaticPlanner(s),
      critic: new browser.AssertionCritic(), driver: new StubDriver(), reporter: silent }, "open cart", { judgment: { opaque: false } });
    expect(direct.verdict.contract).toEqual(result.verdict.contract);
  });

  it("recomputes edited assertions without mutating a stored freeze or earlier result", async () => {
    const s = await stamp();
    const first = await runScenario(s, { driver: new StubDriver(), reporter: silent });
    const before = JSON.stringify(first.result);
    const changed = { ...s, assertions: [...s.assertions, { kind: "request-status" as const, urlIncludes: "/missing", status: 200 }] };
    const second = await runScenario(changed, { driver: new StubDriver(), reporter: silent });
    expect(second.result.verdict.passed).toBe(false);
    expect(compareContracts(first.result.verdict.contract, second.result.verdict.contract)).toBe("changed");
    expect(JSON.stringify(first.result)).toBe(before);
    expect(changed.contract).toBe(s.contract);
  });

  it("keeps legacy files loadable and their identity incomplete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-contract-"));
    try {
      const path = join(dir, "old.skill.json");
      await saveSkillFile(path, base());
      const legacy = await loadSkillFile(path);
      const { result } = await runScenario(legacy, { driver: new StubDriver(), reporter: silent });
      expect(result.verdict.passed).toBe(true);
      expect(compareContracts(result.verdict.contract, result.verdict.contract)).toBe("unknown");
      expect((await loadSkillFile(path)).contract).toBeUndefined();
      const s = await stamp();
      await saveSkillFile(path, s);
      expect((await loadSkillFile(path)).contract).toEqual(s.contract);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("does not claim unchanged custom evidence semantics without a version key", async () => {
    const s = await identifyScenario({ ...base(), assertions: [{ kind: "custom", name: "proof" }] }, { intent: "open cart" });
    const run = (judgmentKey?: string) => runScenario(s, { driver: new StubDriver(), reporter: silent, custom: { proof: () => true }, judgmentKey });
    const unknown = (await run()).result.verdict.contract;
    expect(compareContracts(unknown, unknown)).toBe("unknown");
    expect(compareContracts((await run("evidence-v1")).result.verdict.contract, (await run("evidence-v2")).result.verdict.contract)).toBe("changed");
    expect((await runScenario(await stamp(), { driver: new StubDriver(), reporter: silent, critic: new AssertionCritic() })).result.verdict.contract?.complete).toBe(false);
  });

  it("snapshots assertions before callbacks and fingerprints runtime reanchored checks", async () => {
    const s = await stamp();
    const { result } = await runScenario(s, { driver: new StubDriver(), reporter: silent,
      onStep: () => { s.assertions.push({ kind: "no-console-errors" }); } });
    expect(result.verdict.contract).toEqual(s.contract);
    expect(result.verdict.results).toHaveLength(1);
    const original = await stamp();
    const moved = await runScenario(original, { driver: new StubDriver(), reporter: silent,
      replayEnvironment: { baseUrl: "https://staging.shop", allowedHosts: ["shop"] } });
    expect(moved.result.verdict.passed).toBe(true);
    expect(compareContracts(original.contract, moved.result.verdict.contract)).toBe("changed");
    expect(original.steps[0]).toEqual({ kind: "goto", url: "https://shop/cart" });
  });

  it.each([false, true])("marks shared custom params mutated during judgment as unknown (heal: %s)", async heal => {
    const params = { revision: 1 };
    const s = await identifyScenario({ ...base(), assertions: [{ kind: "custom", name: "proof", params }] },
      { intent: "open cart", judgmentKey: "proof-v1" });
    let calls = 0;
    const { result } = await runScenario(s, { driver: new StubDriver(), reporter: silent, heal,
      judgmentKey: "proof-v1", llm: new ScriptedLlm(['{"action":"done"}', '[]']),
      custom: { proof: received => {
        expect(received).toBe(params);
        if (heal && ++calls === 1) return false;
        received.revision = 2;
        return true;
      } },
    });
    expect(result.verdict.passed).toBe(true);
    expect(result.verdict.contract?.fingerprint).toBe(s.contract.fingerprint);
    expect(compareContracts(s.contract, result.verdict.contract)).toBe("unknown");
  });

  it("stamps discovery and re-stamps suite merged assertions, then matches direct replay", async () => {
    const makeDriver = () => { const d = new StubDriver("https://shop/"); d.els = [{ role: "link", name: "Cart" }]; d.navOn.Cart = "https://shop/cart"; return d; };
    const makeLlm = () => new ScriptedLlm(['{"action":"click","text":"Cart"}', '{"action":"done"}', '[]']);
    const found = await discover("open cart", { driver: makeDriver(), llm: makeLlm(), baseUrl: "https://shop/" });
    expect(found.contract?.complete).toBe(true);
    expect(compareContracts(found.contract, await scenarioContract(found))).toBe("same");
    let stored: Scenario | undefined;
    const store: SkillStore = { load: async () => { if (!stored) throw new Error("miss"); return stored; }, freeze: async (ref, s) => { stored = s; return ref; } };
    const cases = [{ id: "cart", intent: "open cart", url: "https://shop/", assertions: [{ kind: "navigated" as const, to: "shop/cart" }] }];
    const events: TraceEvent[] = [];
    const first = await runSuite(cases, { store, driverFactory: makeDriver, llm: makeLlm(), reporter: silent, heal: false, trace: { emit: e => { events.push(e); } } });
    expect(stored?.contract?.complete).toBe(true);
    expect(compareContracts(found.contract, stored?.contract)).toBe("changed");
    expect(events.find(e => e.kind === "freeze")?.payload).toMatchObject({ contract: stored?.contract });
    expect(first.verdicts[0]?.verdict.contract).toEqual(stored?.contract);
    const direct = await runScenario(stored!, { driver: makeDriver(), reporter: silent });
    expect(direct.result.verdict.contract).toEqual(first.verdicts[0]?.verdict.contract);
    const second = await runSuite(cases, { store, driverFactory: makeDriver, reporter: silent, heal: false });
    expect(second.usage.llmCalls).toBe(0);
    expect(second.verdicts[0]?.verdict.contract).toEqual(stored?.contract);
    expect(node.hashCase(cases[0]!)).toBe(hashCase(cases[0]!));
  });

  it("outcome repair keeps original judgment identity and creates a separate freeze", async () => {
    const s = await identifyScenario({ ...base(), assertions: [{ kind: "navigated", to: "shop/done" }] }, {
      intent: "open cart", provenance: { appContextHash: await hashContractValue("old app description") },
    });
    const before = JSON.stringify(s);
    const driver = new StubDriver(); driver.els = [{ role: "link", name: "Finish" }]; driver.navOn.Finish = "https://shop/done";
    const { result, healedScenario } = await runScenario(s, { driver, heal: true, reporter: silent,
      llm: new ScriptedLlm(['{"action":"click","text":"Finish"}', '{"action":"done"}', '[]']) });
    expect(result.verdict.passed).toBe(true);
    expect(result.verdict.contract).toEqual(s.contract);
    expect(result.verdict.provenance).toEqual(s.provenance);
    expect(healedScenario).toBeDefined();
    expect(healedScenario?.assertions).toEqual(s.assertions);
    expect(healedScenario?.contract).toEqual(s.contract);
    // Outcome discovery did not receive an app description: do not claim it used the old one.
    expect(healedScenario?.provenance).toBeUndefined();
    expect(JSON.stringify(s)).toBe(before);
  });
});
