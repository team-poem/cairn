import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover, loadSkillFile, runScenario, saveSkillFile, selectedItemEquals, CollectionSelectionError } from "../src/index.js";
import type { CollectionObservation, CollectionTarget, DiscoverySelection, Evidence, LlmClient, NetworkRequest,
  ResourceKeyObservation, Scenario, SelectedItemBinding, SelectedItemKey, Target, TraceEvent } from "../src/index.js";
import { startTrace } from "../src/core/trace.js";
import { StubDriver } from "./support/doubles.js";

const reporter = { emit: async () => {} };
const itemKey: SelectedItemKey = { kind: "attribute", scope: "item", attribute: "data-post-id" };
const destination = { kind: "attribute" as const, selector: "#post", attribute: "data-post-id" };

function positional(): CollectionTarget {
  return { root: { role: "list", name: "Posts" }, itemRole: "listitem", target: { role: "link" }, order: "dom", index: 0, expectedCount: 2 };
}
function predicate(): CollectionTarget {
  return { root: { role: "list", name: "Posts" }, itemRole: "listitem", target: { role: "link" }, order: "dom", expectedCount: 2,
    choice: { version: 1, cardinality: 1, policy: "first-dom", identity: itemKey,
      where: [{ kind: "attribute-equals", scope: "item", attribute: "data-open", value: "true" }], maxReselections: 0 } };
}

/** Records every model request and answers from a script. */
class Llm implements LlmClient {
  readonly id = "scripted";
  readonly prompts: Array<{ prompt: string; system?: string }> = [];
  constructor(private readonly replies: string[]) {}
  async complete(prompt: string, opts?: { system?: string }): Promise<string> {
    this.prompts.push({ prompt, system: opts?.system });
    return this.replies.shift() ?? "[]";
  }
}
const noModel: LlmClient = { id: "forbidden", complete: async () => { throw new Error("replay must not call a model"); } };

/** A list whose members are labeled posts. Opening one navigates to its page and loads its record. */
class PostsDriver extends StubDriver {
  readonly calls: string[] = [];
  readonly dispatched: string[] = [];
  readonly requests: NetworkRequest[] = [];
  readonly refs = new Map<string, number>();
  open: boolean[];
  arrival?: string;
  selected?: string;
  saves = true;
  complete = true;
  /** A post's path segment; the label lowercased unless set. */
  paths: Record<string, string> = {};
  api = "https://app/api/posts";
  beforeObserve?: () => void;
  afterDispatch?: () => void;

  constructor(public posts: string[], open?: boolean[]) {
    super("https://app/posts");
    this.open = open ?? posts.map(() => true);
  }
  override async goto(url: string): Promise<void> {
    this.calls.push("goto");
    this.url = url;
    this.requests.push({ method: "GET", url: "https://app/api/session", status: 200 });
  }
  override async observe(): Promise<Evidence> {
    const evidence = await super.observe();
    return { ...evidence, logic: { requests: this.requests.map(r => ({ ...r })), console: [] } };
  }
  async observeCollection(selection: CollectionTarget): Promise<CollectionObservation> {
    this.calls.push("observeCollection");
    this.beforeObserve?.();
    return { order: "dom", complete: this.complete, conditions: [], items: this.posts.map((post, position) => {
      const ref = `ref-${this.calls.length}-${position}`;
      this.refs.set(ref, position);
      return { position, disabled: false, target: { role: "link", name: post, ref, disabled: false, occluded: false },
        ...(selection.choice ? { choice: { complete: true, key: `key-${post}`,
          values: selection.choice.where.map(() => String(this.open[position])) } } : {}) };
    }) };
  }
  private path(post: string): string { return this.paths[post] ?? post.toLowerCase(); }
  private dispatch(target: Target, ref?: string): string {
    const position = ref === undefined ? undefined : this.refs.get(ref);
    if (position === undefined || this.posts[position] !== target.text) throw new Error("exact collection reference required");
    const post = this.posts[position]!;
    this.dispatched.push(post);
    this.selected = post;
    this.url = `https://app/posts/${this.path(post)}`;
    this.requests.push({ method: "GET", url: `${this.api}/${this.path(post)}`, status: 200 });
    this.els = [{ role: "heading", name: "Post" }, { role: "button", name: "Save" }, { role: "button", name: "Load comments" }];
    this.afterDispatch?.();
    return post;
  }
  override async click(target: Target, ref?: string): Promise<void> {
    if (!ref && target.text === "Save" && this.saves && this.selected)
      this.requests.push({ method: "POST", url: `${this.api}/${this.path(this.selected)}/save`, status: 201 });
    if (!ref && target.text === "Load comments" && this.selected)
      this.requests.push({ method: "GET", url: `${this.api}/${this.path(this.selected)}/comments`, status: 200 });
    if (!ref) return super.click(target);
    this.dispatch(target, ref);
  }
  async clickWithSelectedItemEvidence(target: Target, ref: string): Promise<ResourceKeyObservation> {
    return { complete: true, value: `key-${this.dispatch(target, ref)}` };
  }
  async readResourceKey(): Promise<ResourceKeyObservation> {
    return { complete: true, value: `key-${this.arrival ?? this.selected}` };
  }
}

const use = (id: string, reason = "open Alpha") => JSON.stringify({ action: "click", selection: id, reason });
const done = (assertions: unknown[] = [], reason?: string) => JSON.stringify({ action: "done", assertions, reason });

async function discoverWith(driver: PostsDriver, selections: DiscoverySelection[], replies: string[], events: TraceEvent[] = []) {
  const llm = new Llm(replies);
  const scenario = await discover("Open the first post", { driver, llm, baseUrl: "https://app/posts", selections,
    trace: startTrace({ emit: (event: TraceEvent) => { events.push(event); } }, "0.0.0").scope("c1") });
  return { scenario, llm };
}

async function roundTrip(scenario: Scenario): Promise<{ loaded: Scenario; raw: string }> {
  const directory = await mkdtemp(join(tmpdir(), "cairn-discovery-selection-"));
  try {
    const path = join(directory, "first-post.skill.json");
    await saveSkillFile(path, scenario);
    return { loaded: await loadSkillFile(path), raw: await readFile(path, "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function bindingsOf(scenario: Scenario): SelectedItemBinding[] {
  return scenario.assertions.flatMap(a => a.kind === "custom" ? [a.params as unknown as SelectedItemBinding] : []);
}

describe("declared selections in discovery (#343)", () => {
  it("freezes a positional declaration that fresh replay resolves against the current list", async () => {
    const selection: DiscoverySelection = { version: 1, id: "first-post", target: { collection: positional() },
      expect: { role: "heading", text: "Post" }, verify: { source: itemKey, destination } };
    const { scenario, llm } = await discoverWith(new PostsDriver(["Alpha", "Bravo"]), [selection], [use("first-post"), done()]);

    expect(scenario.truncated).toBeUndefined();
    expect(scenario.steps[1]).toEqual({ kind: "click", target: { collection: positional() }, expect: { role: "heading", text: "Post" } });
    expect(llm.prompts[0]!.prompt).toContain('"selection":"first-post"');
    const { loaded, raw } = await roundTrip(scenario);
    expect(raw).not.toMatch(/alpha|"key-|ref-/i);

    const replayDriver = new PostsDriver(["Bravo", "Charlie"]);
    const { result } = await runScenario(loaded, { driver: replayDriver, llm: noModel, reporter, judgmentKey: "posts-v1",
      selectedItemEvidence: { bindings: bindingsOf(loaded) }, custom: { "first-post": selectedItemEquals } });
    expect(replayDriver.dispatched).toEqual(["Bravo"]);
    expect(result.verdict.passed).toBe(true);
    expect(result.usage?.llmCalls).toBe(0);
  });

  it("freezes a predicate declaration's conditions, not the value discovery chose", async () => {
    const selection: DiscoverySelection = { version: 1, id: "open-post", target: { collection: predicate() },
      verify: { source: itemKey, destination } };
    const { scenario } = await discoverWith(new PostsDriver(["Alpha", "Bravo"], [false, true]), [selection],
      [use("open-post", "open Bravo"), done()]);
    expect(scenario.steps[1]).toEqual({ kind: "click", target: { collection: predicate() } });
    const { loaded, raw } = await roundTrip(scenario);
    expect(raw).not.toMatch(/bravo|"key-|ref-/i);

    const replayDriver = new PostsDriver(["Charlie", "Delta"], [true, false]);
    const { result } = await runScenario(loaded, { driver: replayDriver, llm: noModel, reporter, judgmentKey: "posts-v1",
      selectedItemEvidence: { bindings: bindingsOf(loaded) }, custom: { "open-post": selectedItemEquals } });
    expect(replayDriver.dispatched).toEqual(["Charlie"]);
    expect(result.verdict.passed).toBe(true);
    expect(result.usage?.llmCalls).toBe(0);
  });

  it("checks the frozen binding against this run: selecting B and arriving at C fails", async () => {
    const selection: DiscoverySelection = { version: 1, id: "first-post", target: { collection: positional() },
      verify: { source: itemKey, destination } };
    const { scenario } = await discoverWith(new PostsDriver(["Alpha", "Bravo"]), [selection], [use("first-post"), done()]);
    const { loaded } = await roundTrip(scenario);
    const replay = (driver: PostsDriver) => runScenario(loaded, { driver, llm: noModel, reporter, judgmentKey: "posts-v1",
      selectedItemEvidence: { bindings: bindingsOf(loaded) }, custom: { "first-post": selectedItemEquals } });

    const matching = await replay(new PostsDriver(["Bravo", "Charlie"]));
    expect(matching.result.verdict.passed).toBe(true);
    const wrong = new PostsDriver(["Bravo", "Charlie"]);
    wrong.arrival = "Charlie";
    const mismatched = await replay(wrong);
    expect(wrong.dispatched).toEqual(["Bravo"]);
    expect(mismatched.result.verdict.passed).toBe(false);
    expect(mismatched.result.verdict.results.find(r => r.assertion.kind === "custom")?.passed).toBe(false);
  });

  it("drops proof observed after the selection and keeps proof observed before it", async () => {
    const events: TraceEvent[] = [];
    const selection: DiscoverySelection = { version: 1, id: "first-post", target: { collection: positional() } };
    const { scenario } = await discoverWith(new PostsDriver(["Alpha", "Bravo"]), [selection], [use("first-post"), done([
      { kind: "request-status", urlIncludes: "app/api/session", status: 200 },
      { kind: "request-status", urlIncludes: "app/api/posts/alpha", status: 200 },
    ])], events);
    expect(scenario.steps[1]).not.toHaveProperty("expect");
    expect(scenario.steps[1]).not.toHaveProperty("intent");
    expect(scenario.assertions.map(a => a.kind === "request-status" ? a.urlIncludes : a.kind).sort())
      .toEqual(["app/api/session", "no-console-errors", "no-failed-requests"]);
    expect(JSON.stringify(scenario)).not.toMatch(/alpha/i);
    const drops = events.filter(e => e.kind === "gate" && e.payload.gate === "grounding"
      && /run-relative selection/.test(e.payload.reason));
    expect(drops.length).toBeGreaterThanOrEqual(2);
  });

  it("withholds the freeze when an action after the selection loses its only proof", async () => {
    const selection: DiscoverySelection = { version: 1, id: "first-post", target: { collection: positional() },
      verify: { source: itemKey, destination } };
    const { scenario } = await discoverWith(new PostsDriver(["Alpha", "Bravo"]), [selection], [
      use("first-post"),
      JSON.stringify({ action: "click", text: "Save", reason: "save the post" }),
      done([{ kind: "request-status", urlIncludes: "app/api/posts/alpha/save", status: 201 }]),
    ]);
    expect(scenario).toMatchObject({ truncated: true, truncationReason: "selection-unproven" });
  });

  it("withholds the freeze when a read after the selection loses its only proof", async () => {
    const events: TraceEvent[] = [];
    const selection: DiscoverySelection = { version: 1, id: "first-post", target: { collection: positional() },
      verify: { source: itemKey, destination } };
    const { scenario } = await discoverWith(new PostsDriver(["Alpha", "Bravo"]), [selection], [
      use("first-post", "open the first post"),
      JSON.stringify({ action: "click", text: "Load comments", reason: "load the comments" }),
      done([{ kind: "request-status", urlIncludes: "app/api/posts/alpha/comments", status: 200, method: "GET" }]),
    ], events);
    expect(scenario).toMatchObject({ truncated: true, truncationReason: "selection-unproven" });
    expect(JSON.stringify(events)).not.toMatch(/alpha/i);
  });

  it("keeps the selected member's ID out of the trace, model reasons and unprovenAction", async () => {
    const events: TraceEvent[] = [];
    const driver = new PostsDriver(["Alpha", "Bravo"]);
    // A path that starts with the ID leaves no stable prefix, so Save gets no derived expect.
    driver.api = "https://app";
    driver.paths = { Alpha: "4821", Bravo: "4822" };
    const selection: DiscoverySelection = { version: 1, id: "first-post", target: { collection: positional() },
      verify: { source: itemKey, destination } };
    const { scenario } = await discoverWith(driver, [selection], [
      JSON.stringify({ action: "click", text: "Newest", reason: "sort by newest" }),
      use("first-post", "open the first post"),
      JSON.stringify({ action: "click", text: "Save", reason: "save /posts/4821" }),
      done([{ kind: "request-status", urlIncludes: "app/4821", status: 200, method: "GET" }], "saved /posts/4821"),
    ], events);
    expect(driver.requests.map(r => r.url)).toContain("https://app/4821/save");
    expect(scenario).toMatchObject({ truncated: true, truncationReason: "selection-unproven" });
    expect(scenario).not.toHaveProperty("unprovenAction");
    expect(JSON.stringify(events)).not.toMatch(/4821|alpha/i);
    expect(JSON.stringify(scenario)).not.toMatch(/4821|alpha/i);
    expect(scenario.steps[1]).toMatchObject({ target: { text: "Newest" }, intent: "sort by newest" });
  });

  it("withholds the freeze when a waitFor after the selection names the member discovery selected", async () => {
    const selection: DiscoverySelection = { version: 1, id: "first-post", target: { collection: positional() },
      verify: { source: itemKey, destination } };
    const { scenario } = await discoverWith(new PostsDriver(["Alpha", "Bravo"]), [selection], [
      use("first-post"),
      JSON.stringify({ action: "waitFor", until: { url: "/posts/alpha" } }),
      done(),
    ]);
    expect(scenario).toMatchObject({ truncated: true, truncationReason: "selection-unproven" });
  });

  it("lets only a click naming an unused declared ID consume it", async () => {
    const events: TraceEvent[] = [];
    const driver = new PostsDriver(["Alpha", "Bravo"]);
    const selection: DiscoverySelection = { version: 1, id: "first-post", target: { collection: positional() } };
    const { scenario, llm } = await discoverWith(driver, [selection], [
      use("second-post"),
      JSON.stringify({ action: "hover", selection: "first-post" }),
      JSON.stringify({ action: "click", selection: "first-post", text: "Alpha" }),
      use("first-post"),
      use("first-post"),
      done(),
    ], events);
    expect(driver.dispatched).toEqual(["Alpha"]);
    expect(scenario.steps.filter(step => "target" in step && step.target.collection)).toHaveLength(1);
    expect(events.filter(e => e.kind === "gate" && e.payload.gate === "declared-selection")).toHaveLength(4);
    expect(llm.prompts[4]!.prompt).not.toContain("Declared selections not yet used");
  });

  it("truncates a discovery that never consumed its declaration", async () => {
    const driver = new PostsDriver(["Alpha", "Bravo"]);
    driver.els = [{ role: "link", name: "Alpha" }];
    const selection: DiscoverySelection = { version: 1, id: "first-post", target: { collection: positional() } };
    const { scenario } = await discoverWith(driver, [selection], [JSON.stringify({ action: "click", text: "Alpha" }), done()]);
    expect(scenario.truncated).toBe(true);
    expect(scenario.truncationReason).toBe("selection-unbound");
  });

  it.each<[string, unknown]>([
    ["a mixed legacy locator", { version: 1, id: "s", target: { collection: positional(), text: "Alpha" } }],
    ["a choice without verify", { version: 1, id: "s", target: { collection: predicate() } }],
    ["a binding reference", { version: 1, id: "s", verify: { source: itemKey, destination }, target: { collection: {
      ...predicate(), choice: { ...predicate().choice!, where: [{ kind: "attribute-equals", scope: "item",
        attribute: "data-post-id", value: { bindingId: "earlier" } }] } } } }],
    ["an unknown field", { version: 1, id: "s", target: { collection: positional() }, label: "Alpha" }],
    ["an invalid ID", { version: 1, id: "", target: { collection: positional() } }],
  ])("refuses %s before any browser operation", async (_label, declaration) => {
    const driver = new PostsDriver(["Alpha"]);
    await expect(discover("x", { driver, llm: new Llm([]), baseUrl: "https://app/posts",
      selections: [declaration as DiscoverySelection] })).rejects.toBeInstanceOf(CollectionSelectionError);
    expect(driver.calls).toEqual([]);
  });

  it("refuses a driver without collection observations before any browser operation", async () => {
    const driver = new StubDriver();
    const visited: string[] = [];
    driver.goto = async url => { visited.push(url); };
    await expect(discover("x", { driver, llm: new Llm([]), baseUrl: "https://app/posts",
      selections: [{ version: 1, id: "s", target: { collection: positional() } }] }))
      .rejects.toMatchObject({ code: "unsupported" });
    expect(visited).toEqual([]);
  });

  it("leaves prompts unchanged without declarations and keeps an ordinary click fixed", async () => {
    const plain = new Llm([JSON.stringify({ action: "click", text: "Alpha", reason: "open Alpha" }), done()]);
    const driver = new PostsDriver(["Alpha"]);
    driver.els = [{ role: "link", name: "Alpha" }];
    const scenario = await discover("Open Alpha", { driver, llm: plain, baseUrl: "https://app/posts" });
    expect(plain.prompts[0]!.system).not.toContain("Declared selections");
    expect(plain.prompts[0]!.prompt).not.toContain("Declared selections");
    expect(scenario.steps[1]).toMatchObject({ kind: "click", target: { text: "Alpha" }, intent: "open Alpha" });
  });

  it("stops without another click when a dispatched selection cannot be confirmed", async () => {
    const driver = new PostsDriver(["Alpha", "Bravo"]);
    driver.afterDispatch = () => { throw new Error("transport lost after input"); };
    const selection: DiscoverySelection = { version: 1, id: "first-post", target: { collection: positional() } };
    const { scenario, llm } = await discoverWith(driver, [selection], [use("first-post"), use("first-post"), done()]);
    expect(driver.dispatched).toEqual(["Alpha"]);
    expect(scenario).toMatchObject({ truncated: true, truncationReason: "selection-failed", assertions: [] });
    expect(scenario.steps).toEqual([{ kind: "goto", url: "https://app/posts" }]);
    expect(llm.prompts).toHaveLength(1);
  });

  it("refuses an incomplete collection without dispatch", async () => {
    const driver = new PostsDriver(["Alpha", "Bravo"]);
    driver.complete = false;
    const selection: DiscoverySelection = { version: 1, id: "first-post", target: { collection: positional() } };
    const { scenario } = await discoverWith(driver, [selection], [use("first-post"), done()]);
    expect(driver.dispatched).toEqual([]);
    expect(scenario.truncationReason).toBe("selection-failed");
  });

  it("propagates cancellation during the collection observation without dispatch", async () => {
    const controller = new AbortController();
    const driver = new PostsDriver(["Alpha", "Bravo"]);
    driver.beforeObserve = () => controller.abort();
    await expect(discover("Open the first post", { driver, llm: new Llm([use("first-post")]), baseUrl: "https://app/posts",
      signal: controller.signal, selections: [{ version: 1, id: "first-post", target: { collection: positional() } }] }))
      .rejects.toThrow();
    expect(driver.dispatched).toEqual([]);
  });

  it("counts selection work against the discovery budget", async () => {
    const driver = new PostsDriver(["Alpha", "Bravo"]);
    await expect(discover("Open the first post", { driver, llm: new Llm([use("first-post"), done()]), baseUrl: "https://app/posts",
      budget: { maxModelCalls: 1 }, selections: [{ version: 1, id: "first-post", target: { collection: positional() } }] }))
      .rejects.toMatchObject({ name: "BudgetExceededError" });
    expect(driver.dispatched).toEqual(["Alpha"]);
  });
});
