import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as node from "../src/index.js";
import * as browser from "../src/browser.js";
import { persistentTarget } from "../src/core/observation.js";
import { StubDriver } from "./support/doubles.js";
import type { CollectionObservation, CollectionTarget, Scenario, Target } from "../src/index.js";

const silent = { emit: async () => {} };
const intent = "Open the first result in the current collection";

function selection(): CollectionTarget {
  return {
    root: { role: "list", name: "Results" },
    itemRole: "listitem",
    target: { role: "button" },
    order: "dom",
    index: 0,
    expectedCount: 2,
    conditions: [{ control: { role: "searchbox", name: "Search" }, value: "current" }],
  };
}

function scenario(): Scenario {
  return {
    name: "Open current first result",
    steps: [
      { kind: "goto", url: "https://app/results" },
      { kind: "click", target: { collection: selection() } },
    ],
    assertions: [{ kind: "navigated", to: "app/selected" }],
  };
}

/** The adapter reports current membership and dispatches only the exact run-local reference. */
class CollectionDriver extends StubDriver {
  readonly observations: CollectionTarget[] = [];
  readonly dispatched: Array<{ target: Target; ref: string }> = [];
  private readonly namesByRef = new Map<string, string>();

  constructor(private readonly session: string, private readonly names: string[]) {
    super();
  }

  async observeCollection(declaration: CollectionTarget): Promise<CollectionObservation> {
    this.observations.push(structuredClone(declaration));
    return {
      order: "dom",
      complete: true,
      items: this.names.map((name, position) => {
        const ref = `${this.session}:current-member:${position}`;
        this.namesByRef.set(ref, name);
        return { position, target: { role: "button", name, ref, disabled: false } };
      }),
      conditions: [{ value: "current" }],
    };
  }

  override async click(target: Target, ref?: string): Promise<void> {
    if (!ref || this.namesByRef.get(ref) !== target.text) throw new Error("Exact collection reference required");
    this.dispatched.push({ target: structuredClone(target), ref });
    this.clicked.push(target.text!);
    this.url = new URL("/selected", this.url).href;
  }
}

describe("collection persistence and public API compatibility", () => {
  it("round-trips the declaration in a bare Scenario without inventing identity or runtime refs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cairn-collection-"));
    try {
      const path = join(directory, "first-result.skill.json");
      const frozen = scenario();
      await node.saveSkillFile(path, frozen);
      const raw = await readFile(path, "utf8");
      const loaded = await node.loadSkillFile(path);

      expect(JSON.parse(raw)).toEqual(frozen);
      expect(JSON.parse(raw)).not.toHaveProperty("scenario");
      expect(loaded).toEqual(frozen);
      expect(loaded.contract).toBeUndefined();
      expect(loaded.steps[1]).toEqual({ kind: "click", target: { collection: selection() } });
      expect(raw).not.toMatch(/"(?:ref|uid|handle)"/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists a private deep copy of the declaration, including nested condition locators", () => {
    const target: Target = { collection: selection() };
    const persisted = persistentTarget(target);
    expect(persisted).toEqual(target);
    expect(Object.keys(persisted)).toEqual(["collection"]);
    expect(persisted.collection).not.toBe(target.collection);
    expect(persisted.collection!.root).not.toBe(target.collection!.root);
    expect(persisted.collection!.target).not.toBe(target.collection!.target);
    expect(persisted.collection!.conditions).not.toBe(target.collection!.conditions);
    expect(persisted.collection!.conditions![0]).not.toBe(target.collection!.conditions![0]);
    expect(persisted.collection!.conditions![0]!.control).not.toBe(target.collection!.conditions![0]!.control);

    target.collection!.root.name = "Changed root";
    target.collection!.target.name = "Old resource";
    target.collection!.conditions![0]!.control.name = "Changed query";
    target.collection!.conditions![0]!.value = "different";
    expect(persisted).toEqual({ collection: selection() });
  });

  it.each([
    { text: "Old resource" }, { role: "button" }, { index: 0 }, { nth: 0 },
    { selector: "#old-resource" }, { ref: "old-session:node" },
  ])("refuses mixed legacy locators or runtime references instead of persisting them: %j", extra => {
    const target = { collection: selection(), ...extra };
    expect(() => persistentTarget(target)).toThrow(node.CollectionSelectionError);
    expect(() => browser.validateCollectionTarget(target)).toThrow(browser.CollectionSelectionError);
  });

  it("scores an explicit collection position without claiming fixed-resource identity", () => {
    const target = { collection: selection() };
    const score = node.scoreTarget(target);
    expect(score.weak).toBe(false);
    expect(score.score).toBeGreaterThan(node.scoreTarget({ text: "Old resource" }).score);
    expect(score.reason).toMatch(/collection position/);
    expect(score.reason).toMatch(/not fixed-resource identity/);
    expect(browser.scoreTarget(target)).toEqual(score);
  });

  it.each([node, browser])("excludes collection targeting from judgment identity but includes changed assertions", async api => {
    const frozen = await api.identifyScenario(scenario(), { intent });
    const changedDeclaration = selection();
    changedDeclaration.index = 1;
    changedDeclaration.root.name = "Different results";
    changedDeclaration.target.name = "Different action";
    changedDeclaration.conditions![0]!.value = "different query";
    const changedTarget = await api.identifyScenario({ ...frozen, steps: [
      frozen.steps[0]!, { kind: "click", target: { collection: changedDeclaration } },
    ] });
    const changedAssertions = await api.identifyScenario({ ...frozen,
      assertions: [{ kind: "navigated", to: "app/different-outcome" }],
    });

    expect(frozen.contract.complete).toBe(true);
    expect(api.compareContracts(frozen.contract, changedTarget.contract)).toBe("same");
    expect(changedTarget.contract.fingerprint).toBe(frozen.contract.fingerprint);
    expect(api.compareContracts(frozen.contract, changedAssertions.contract)).toBe("changed");
  });

  it("replays a hand-authored declaration against fresh first members with zero model calls and no frozen edits", async () => {
    const frozen = await node.identifyScenario(scenario(), { intent });
    const before = JSON.stringify(frozen);
    const complete = vi.fn(async () => { throw new Error("No model allowed during collection replay"); });
    const first = new CollectionDriver("first-run", ["Open Alpha", "Open Beta"]);
    const second = new CollectionDriver("second-run", ["Open Beta", "Open Alpha"]);

    for (const driver of [first, second]) {
      const result = await node.runScenario(frozen, { driver, reporter: silent,
        llm: { id: "forbidden", complete }, budget: { maxModelCalls: 0 },
      });
      expect(result.result.verdict.passed).toBe(true);
      expect(result.result.verdict.contract).toEqual(frozen.contract);
      expect(result.result.usage?.llmCalls).toBe(0);
      expect(result.healedScenario).toBeUndefined();
      expect(driver.observations).toEqual([selection()]);
      expect(result.result.evidence.execution.actions[1]!.step).toEqual(frozen.steps[1]);
      expect(JSON.stringify(frozen)).toBe(before);
    }

    expect(first.dispatched).toEqual([{ target: { text: "Open Alpha", role: "button" }, ref: "first-run:current-member:0" }]);
    expect(second.dispatched).toEqual([{ target: { text: "Open Beta", role: "button" }, ref: "second-run:current-member:0" }]);
    expect(complete).not.toHaveBeenCalled();
    expect(before).not.toMatch(/Open Alpha|Open Beta|"ref"|current-member/);
  });

  it("supports the same fresh positional replay through the browser public entry", async () => {
    const frozen = await browser.identifyScenario(scenario(), { intent });
    const before = JSON.stringify(frozen);
    const complete = vi.fn(async () => { throw new Error("No model allowed during collection replay"); });
    const first = new CollectionDriver("browser-first", ["Open Alpha", "Open Beta"]);
    const second = new CollectionDriver("browser-second", ["Open Beta", "Open Alpha"]);

    for (const driver of [first, second]) {
      const result = await browser.runHarness({
        context: new browser.InlineContextProvider(), planner: new browser.StaticPlanner(frozen),
        critic: new browser.LlmCritic({ id: "forbidden", complete }), driver, reporter: silent,
      }, intent, { judgment: { opaque: false }, budget: { maxModelCalls: 0 } });
      expect(result.verdict.passed).toBe(true);
      expect(result.verdict.contract).toEqual(frozen.contract);
      expect(driver.observations).toEqual([selection()]);
      expect(JSON.stringify(frozen)).toBe(before);
    }

    expect(first.dispatched).toEqual([{ target: { text: "Open Alpha", role: "button" }, ref: "browser-first:current-member:0" }]);
    expect(second.dispatched).toEqual([{ target: { text: "Open Beta", role: "button" }, ref: "browser-second:current-member:0" }]);
    expect(complete).not.toHaveBeenCalled();
  });

  it("reanchors only declared page URLs while preserving collection declaration data", () => {
    const frozen = scenario();
    const target: Target = { collection: { ...selection(),
      root: { role: "list", name: "https://app/results" },
      conditions: [{ control: { role: "searchbox", name: "Search" }, value: "https://app/query" }],
    } };
    frozen.steps[1] = { kind: "click", target, expect: { url: "app/selected" } };
    const before = JSON.stringify(frozen);
    const environment: node.ReplayEnvironment = { baseUrl: "http://localhost:3000", allowedHosts: ["app"] };
    const mapped = node.reanchorScenario(frozen, environment);

    expect(mapped.steps[0]).toEqual({ kind: "goto", url: "http://localhost:3000/results" });
    expect(mapped.steps[1]).toEqual({ kind: "click", target, expect: { url: "localhost:3000/selected" } });
    expect(mapped.assertions).toEqual([{ kind: "navigated", to: "localhost:3000/selected" }]);
    expect(mapped.steps[1] && "target" in mapped.steps[1] && mapped.steps[1].target).toBe(target);
    expect(browser.reanchorScenario(frozen, environment)).toEqual(mapped);
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it("keeps legacy nth targets on the same-named path without observing a collection", async () => {
    const target: Target = { text: "Open", role: "button", nth: 1 };
    const driver = new StubDriver();
    const observeCollection = vi.fn(async (): Promise<CollectionObservation> => {
      throw new Error("Legacy nth must not opt into collection selection");
    });
    const click = vi.spyOn(driver, "click");
    const legacy = { ...scenario(), steps: [{ kind: "click" as const, target }],
      assertions: [{ kind: "no-console-errors" as const }],
    };
    const { result } = await node.runScenario(legacy, { driver: Object.assign(driver, { observeCollection }), reporter: silent });

    expect(result.verdict.passed).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledWith(target, undefined);
    expect(observeCollection).not.toHaveBeenCalled();
    expect(persistentTarget(target)).toEqual(target);
    expect(node.scoreTarget(target)).toMatchObject({ score: 0.6, weak: false });
    expect(legacy.steps[0]!.target).toEqual({ text: "Open", role: "button", nth: 1 });
  });
});
