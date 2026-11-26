import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as node from "../src/index.js";
import { persistentTarget } from "../src/core/observation.js";
import { resolveCollectionTarget, validateCollectionTarget } from "../src/core/collection.js";
import { CollectionSelectionError } from "../src/core/collection.js";
import { StubDriver } from "./support/doubles.js";
import type { CollectionObservation, CollectionTarget, Scenario, Target } from "../src/index.js";

const silent = { emit: async () => {} };

const role = (readerId?: string): CollectionTarget => ({
  root: { role: "list", name: "Results" }, ...(readerId ? { readerId } : {}),
  itemRole: "listitem", target: { role: "button" }, order: "dom", index: 0, expectedCount: 2,
});
const links = (readerId?: string): CollectionTarget => ({
  links: { scope: ".grid", member: ":scope > a" }, ...(readerId ? { readerId } : {}),
  order: "dom", index: 0, expectedCount: 2,
});
const scenario = (collection: CollectionTarget): Scenario => ({
  name: "Open the first result",
  steps: [{ kind: "goto", url: "https://app/results" }, { kind: "click", target: { collection } }],
  assertions: [{ kind: "navigated", to: "app/selected" }],
});

/** A host driver whose readers are keyed by the declared ID, as the issue describes. */
class ReaderDriver extends StubDriver {
  readonly seen: Array<string | undefined> = [];
  override readonly clicked: string[] = [];
  constructor(private readonly readers: Record<string, string[]>, private readonly fallback?: string[]) { super(); }

  async observeCollection(declaration: CollectionTarget): Promise<CollectionObservation> {
    this.seen.push(declaration.readerId);
    const names = declaration.readerId === undefined ? this.fallback : this.readers[declaration.readerId];
    if (!names) throw new CollectionSelectionError("unsupported", "no reader for the declared ID");
    return { order: "dom", complete: true, conditions: [],
      items: names.map((name, position) => ({ position, target: { role: "button", name, ref: `r:${position}`, disabled: false } })) };
  }
  override async click(target: Target, ref?: string): Promise<void> {
    if (!ref) throw new Error("Exact collection reference required");
    this.clicked.push(target.text!);
    this.url = new URL("/selected", this.url).href;
  }
}

describe("collection reader ID (#370)", () => {
  it.each([["role", role], ["link", links]] as const)("keeps a %s declaration's readerId through validation, persistence and save/load", async (_, make) => {
    const target: Target = { collection: make("catalog.v2") };
    expect(validateCollectionTarget(target)).toEqual(target.collection);
    expect(persistentTarget(target)).toEqual(target);

    const directory = await mkdtemp(join(tmpdir(), "cairn-reader-id-"));
    try {
      const path = join(directory, "reader.skill.json");
      await node.saveSkillFile(path, scenario(make("catalog.v2")));
      expect(JSON.parse(await readFile(path, "utf8")).steps[1].target.collection.readerId).toBe("catalog.v2");
      expect((await node.loadSkillFile(path)).steps[1]).toEqual({ kind: "click", target });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([["empty", ""], ["blank", "  "], ["a number", 7], ["an object", {}], ["too long", "a".repeat(101)], ["a leading dash", "-x"], ["a space", "a b"]])(
    "refuses a readerId that is %s", (_, bad) => {
      for (const make of [role, links]) {
        const collection = { ...make(), readerId: bad } as unknown as CollectionTarget;
        expect(() => validateCollectionTarget({ collection })).toThrow(/readerId/);
      }
    });

  it("replays after a save/load round trip with the declared ID, and two same-named lists reach different readers", async () => {
    const readers = { "catalog.v1": ["Old Alpha", "Old Beta"], "catalog.v2": ["New Alpha", "New Beta"] };
    for (const [id, expected] of [["catalog.v1", "Old Alpha"], ["catalog.v2", "New Alpha"]] as const) {
      const loaded = JSON.parse(JSON.stringify(scenario(role(id)))) as Scenario;
      const driver = new ReaderDriver(readers);
      const { result } = await node.runScenario(loaded, { driver, reporter: silent });
      expect(result.verdict.passed).toBe(true);
      expect(driver.seen).toEqual([id]);
      expect(driver.clicked).toEqual([expected]);
    }
  });

  it.each([["role", role], ["link", links]] as const)("reports an unsupported %s readerId and performs no click", async (_, make) => {
    const driver = new ReaderDriver({ "catalog.v1": ["Old Alpha", "Old Beta"] }, ["Default Alpha", "Default Beta"]);
    await expect(resolveCollectionTarget(driver, { collection: make("catalog.v9") }))
      .rejects.toMatchObject({ code: "unsupported", kind: "handler" });
    const { result } = await node.runScenario(scenario(make("catalog.v9")), { driver, reporter: silent });
    expect(result.verdict.passed).toBe(false);
    expect(driver.clicked).toEqual([]);
    expect(driver.seen).toContain("catalog.v9");
    expect(driver.seen).not.toContain(undefined);
  });

  it("replays a target without an ID as before", async () => {
    const driver = new ReaderDriver({ "catalog.v2": ["New Alpha", "New Beta"] }, ["Default Alpha", "Default Beta"]);
    const { result } = await node.runScenario(scenario(role()), { driver, reporter: silent });
    expect(result.verdict.passed).toBe(true);
    expect(driver.seen).toEqual([undefined]);
    expect(driver.clicked).toEqual(["Default Alpha"]);
  });

  it("does not let a recognized ID bypass the declared total or position checks", async () => {
    const short = new ReaderDriver({ "catalog.v2": ["Only One"] });
    await expect(resolveCollectionTarget(short, { collection: role("catalog.v2") })).rejects.toMatchObject({ code: "incomplete" });
    const far = new ReaderDriver({ "catalog.v2": ["A", "B"] });
    const target = { collection: { ...role("catalog.v2"), index: 5 } } as Target;
    await expect(resolveCollectionTarget(far, target)).rejects.toMatchObject({ code: "missing" });
    expect(short.clicked).toEqual([]);
    expect(far.clicked).toEqual([]);
  });
});
