import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollectionSelectionError, discover, loadSkillFile, runScenario, saveSkillFile, selectedItemEquals, validateCollectionTarget } from "../src/index.js";
import { validateSelectedItemBinding } from "../src/core/selected-item-evidence.js";
import type { CollectionObservation, CollectionTarget, DiscoverySelection, LlmClient, ResourceKeyObservation, Scenario,
  SelectedItemBinding, SelectedItemKey, Target } from "../src/index.js";
import { StubDriver } from "./support/doubles.js";

const reporter = { emit: async () => {} };
const grid = (): CollectionTarget => ({ links: { scope: ".grid", member: ":scope > a" }, order: "dom", index: 1, expectedCount: 3 });
const linkVerify = { source: { kind: "href" as const }, destination: { kind: "location" as const } };

class Llm implements LlmClient {
  readonly id = "scripted";
  calls = 0;
  constructor(private readonly replies: string[]) {}
  async complete(): Promise<string> { this.calls++; return this.replies.shift() ?? "[]"; }
}
const noModel: LlmClient = { id: "forbidden", complete: async () => { throw new Error("replay must not call a model"); } };

/** A grid of plain links. A click navigates to the link's href, or to `redirects[href]` when set. */
class GridDriver extends StubDriver {
  readonly dispatched: string[] = [];
  readonly observed: CollectionTarget[] = [];
  readonly redirects: Record<string, string> = {};
  /** Posts whose link opens a new tab: the destination check refuses them before dispatch. */
  readonly newTab = new Set<string>();
  private readonly refs = new Map<string, string>();
  constructor(public posts: string[]) { super("https://app/posts"); }
  private href(post: string): string { return `https://app/posts/${post.toLowerCase()}`; }
  async observeCollection(selection: CollectionTarget): Promise<CollectionObservation> {
    this.observed.push(structuredClone(selection));
    return { order: "dom", complete: true, conditions: [], items: this.posts.map((post, position) => {
      const ref = `ref-${this.observed.length}-${position}`;
      this.refs.set(ref, post);
      return { position, disabled: false, target: { role: "link", name: post, ref, disabled: false } };
    }) };
  }
  private dispatch(ref?: string): string {
    const post = ref === undefined ? undefined : this.refs.get(ref);
    if (!post) throw new Error("exact collection reference required");
    this.dispatched.push(post);
    this.url = this.redirects[this.href(post)] ?? this.href(post);
    return post;
  }
  override async click(target: Target, ref?: string): Promise<void> {
    if (!ref) return super.click(target);
    this.dispatch(ref);
  }
  async clickWithSelectedItemEvidence(_target: Target, ref: string, source: SelectedItemKey): Promise<ResourceKeyObservation> {
    if (source.kind !== "href") throw new Error("link collections bind their href");
    if (this.newTab.has(this.refs.get(ref)!)) throw new CollectionSelectionError("unsupported", "the selected link has no same-tab document destination");
    return { complete: true, value: this.href(this.dispatch(ref)) };
  }
  async readResourceKey(): Promise<ResourceKeyObservation> { return { complete: true, value: this.url }; }
}

async function roundTrip(scenario: Scenario): Promise<{ loaded: Scenario; raw: string }> {
  const directory = await mkdtemp(join(tmpdir(), "cairn-link-selection-"));
  try {
    const path = join(directory, "second-post.skill.json");
    await saveSkillFile(path, scenario);
    return { loaded: await loadSkillFile(path), raw: await readFile(path, "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const bindingsOf = (scenario: Scenario) =>
  scenario.assertions.flatMap(a => a.kind === "custom" ? [a.params as unknown as SelectedItemBinding] : []);

async function discoverSecond(selection: DiscoverySelection, driver = new GridDriver(["Alpha", "Bravo", "Charlie"])) {
  const llm = new Llm([JSON.stringify({ action: "click", selection: selection.id, reason: "open Bravo" }), JSON.stringify({ action: "done" })]);
  const scenario = await discover("Open the second post", { driver, llm, baseUrl: "https://app/posts", selections: [selection] });
  return { scenario, driver };
}

describe("declared positional selection over plain links (#343)", () => {
  it("freezes the declared grid position, and fresh replay after a reorder opens today's second link with no model", async () => {
    const selection: DiscoverySelection = { version: 1, id: "second-post", target: { collection: grid() }, verify: linkVerify };
    const { scenario, driver } = await discoverSecond(selection);
    expect(scenario.truncated).toBeUndefined();
    expect(driver.dispatched).toEqual(["Bravo"]);
    expect(scenario.steps[1]).toEqual({ kind: "click", target: { collection: grid() } });

    const { loaded, raw } = await roundTrip(scenario);
    expect(raw).not.toMatch(/bravo|ref-/i);
    expect(loaded.steps[1]).toEqual({ kind: "click", target: { collection: grid() } });

    const replayDriver = new GridDriver(["Charlie", "Alpha", "Bravo"]);
    const { result } = await runScenario(loaded, { driver: replayDriver, llm: noModel, reporter, judgmentKey: "posts-v1",
      selectedItemEvidence: { bindings: bindingsOf(loaded) }, custom: { "second-post": selectedItemEquals } });
    expect(replayDriver.dispatched).toEqual(["Alpha"]);
    expect(replayDriver.observed).toEqual([grid()]);
    expect(result.verdict.passed).toBe(true);
    expect(result.usage?.llmCalls).toBe(0);
  });

  it("refuses in discovery, before dispatch, a link the destination check cannot observe", async () => {
    const selection: DiscoverySelection = { version: 1, id: "second-post", target: { collection: grid() }, verify: linkVerify };
    const driver = new GridDriver(["Alpha", "Bravo", "Charlie"]);
    driver.newTab.add("Bravo");
    const outcome = await discoverSecond(selection, driver).then(({ scenario }) => scenario, (error: unknown) => error);
    expect(driver.dispatched).toEqual([]);
    expect(JSON.stringify(outcome)).not.toContain('"collection"');
  });

  it("fails replay when the selected link arrives somewhere else", async () => {
    const selection: DiscoverySelection = { version: 1, id: "second-post", target: { collection: grid() }, verify: linkVerify };
    const { loaded } = await roundTrip((await discoverSecond(selection)).scenario);
    const wrong = new GridDriver(["Alpha", "Bravo", "Charlie"]);
    wrong.redirects["https://app/posts/bravo"] = "https://app/posts/charlie";
    const { result } = await runScenario(loaded, { driver: wrong, llm: noModel, reporter, judgmentKey: "posts-v1",
      selectedItemEvidence: { bindings: bindingsOf(loaded) }, custom: { "second-post": selectedItemEquals } });
    expect(wrong.dispatched).toEqual(["Bravo"]);
    expect(result.verdict.passed).toBe(false);
    expect(result.verdict.results.find(r => r.assertion.kind === "custom")?.passed).toBe(false);
    expect(result.usage?.llmCalls).toBe(0);
  });

  it("reads a link's arrival only at its own selection step, so a later step cannot reach the href and hide a wrong arrival", () => {
    const click = { kind: "click" as const, target: { collection: grid() } };
    const binding = (destination: unknown[]) => ({ version: 1, id: "second-post", relation: "resource-key-equals", phase: "replay",
      source: { after: [click], key: { kind: "href" } }, destination: { after: destination, key: { kind: "location" } } });
    expect(() => validateSelectedItemBinding(binding([click]))).not.toThrow();
    expect(() => validateSelectedItemBinding(binding([click, { kind: "goto", url: "https://app/posts/bravo" }]))).toThrow(/selection step/);
  });

  it("accepts wrapped cards with destination grouping and keeps the declaration verbatim", () => {
    const cards: Target = { collection: { links: { scope: "#feed", member: ":scope > .card", action: "a[href]", group: "destination" },
      order: "dom", index: 0, expectedCount: 4 } };
    expect(validateCollectionTarget(cards)).toEqual(cards.collection);
  });

  it.each([
    ["no expected count", { links: { scope: ".grid", member: ":scope > a" }, order: "dom", index: 0 }],
    ["an unanchored member selector", { links: { scope: ".grid", member: ".grid > a" }, order: "dom", index: 0, expectedCount: 3 }],
    ["grouping without a declared action", { links: { scope: ".grid", member: ":scope > a", group: "destination" }, order: "dom", index: 0, expectedCount: 3 }],
    ["a position past the declared total", { links: { scope: ".grid", member: ":scope > a" }, order: "dom", index: 3, expectedCount: 3 }],
    ["mixed role fields", { links: { scope: ".grid", member: ":scope > a" }, itemRole: "listitem", order: "dom", index: 0, expectedCount: 3 }],
    ["a predicate choice", { links: { scope: ".grid", member: ":scope > a" }, order: "dom", expectedCount: 3,
      choice: { version: 1, cardinality: 1, policy: "first-dom", identity: { kind: "attribute", scope: "item", attribute: "data-id" },
        where: [{ kind: "attribute-equals", scope: "item", attribute: "data-id", value: "a" }], maxReselections: 0 } }],
  ])("refuses a link declaration with %s before any browser work", async (_label, collection) => {
    const driver = new GridDriver(["Alpha", "Bravo", "Charlie"]);
    const llm = new Llm([]);
    await expect(discover("Open a post", { driver, llm, baseUrl: "https://app/posts",
      selections: [{ version: 1, id: "post", target: { collection } as Target }] })).rejects.toMatchObject({ code: "invalid" });
    expect(driver.observed).toEqual([]);
    expect(llm.calls).toBe(0);
  });

  it("refuses an attribute binding on a link collection and a link binding on a role collection", async () => {
    const attribute: DiscoverySelection = { version: 1, id: "post", target: { collection: grid() },
      verify: { source: { kind: "attribute", scope: "item", attribute: "data-id" }, destination: { kind: "attribute", selector: "#post", attribute: "data-id" } } };
    const role: DiscoverySelection = { version: 1, id: "post", verify: linkVerify, target: { collection: {
      root: { role: "list", name: "Posts" }, itemRole: "listitem", target: { role: "link" }, order: "dom", index: 0, expectedCount: 2 } } };
    for (const selection of [attribute, role])
      await expect(discover("Open a post", { driver: new GridDriver(["Alpha"]), llm: new Llm([]), baseUrl: "https://app/posts",
        selections: [selection] })).rejects.toThrow();
    expect(() => validateCollectionTarget({ collection: grid() })).not.toThrow(CollectionSelectionError);
  });
});
