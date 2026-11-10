import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetExceededError, discover, explore, MAX_PAGE_GUIDANCE_EXPIRATIONS, PAGE_GUIDANCE_TIMEOUT_MS } from "../src/index.js";
import type { CompleteOptions, DiscoverOptions, ExploreOptions, LlmClient, PageElement, Target, TraceEvent } from "../src/index.js";
import { startTrace } from "../src/core/trace.js";
import { createScrollNoProgressPolicy } from "../src/core/scroll-policy.js";
import type { SnapshotOptions } from "../src/core/types.js";
import { StubDriver } from "./support/doubles.js";

const START = "https://private.example/start";
const CLICK = '{"action":"click","text":"Open item","role":"link"}';
const DONE = '{"action":"done"}';
const modes = ["discover", "explore"] as const;
type Mode = typeof modes[number];

class ChangingPage extends StubDriver {
  tick = 0;
  unstable = false;
  refs = false;
  duplicate = false;
  failClicks = false;
  snapshots = 0;
  observations = 0;
  exact: string[] = [];
  afterObserve?: () => void;
  afterSnapshot?: () => void;
  constructor() { super(START); }
  override async snapshot(): Promise<PageElement[]> {
    this.snapshots++;
    if (this.unstable) this.tick++;
    const rows: PageElement[] = [
      { role: "status", name: `Private countdown ${this.tick}` },
      { role: "link", name: "Open item", ...(this.refs ? { ref: "private-driver-ref" } : {}) },
      ...(this.duplicate ? [{ role: "link", name: "Open item" }] : []),
    ];
    this.afterSnapshot?.();
    return rows;
  }
  override async observe() {
    this.observations++;
    this.afterObserve?.();
    return super.observe();
  }
  async locateRef(): Promise<Target> { return { text: "Open item", role: "link", selector: "#open" }; }
  override async click(target: Target, ref?: string) {
    if (this.failClicks) throw new Error("click refused");
    if (ref) this.exact.push(ref);
    await super.click(target);
  }
}

class Decisions implements LlmClient {
  readonly id = "scripted-guidance-expiration";
  decisions: { prompt: string; system?: string }[] = [];
  proposals = 0;
  constructor(private readonly reply: (n: number, prompt: string) => string = () => CLICK) {}
  async complete(prompt: string, options?: CompleteOptions) {
    if (prompt.includes("Propose the verification assertions.")) { this.proposals++; return "[]"; }
    this.decisions.push({ prompt, system: options?.system });
    return this.reply(this.decisions.length, prompt);
  }
}

const traced = () => {
  const events: TraceEvent[] = [];
  return { events, trace: startTrace({ emit(event) { events.push(event); } }, "test").scope("case") };
};
const guidanceGates = (events: TraceEvent[]) => events.flatMap(event =>
  event.kind === "gate" && event.payload.gate === "page-guidance" ? [event.payload] : []);
const terminalGates = (events: TraceEvent[]) => guidanceGates(events).filter(payload => payload.code === "page-guidance-expired");

function run(mode: Mode, driver: ChangingPage, llm: Decisions, options: Partial<DiscoverOptions & ExploreOptions> = {}) {
  const opts = { driver, llm, baseUrl: START, maxSteps: 20, pageGuidance: () => "Private guidance", ...options };
  return mode === "discover" ? discover("Open an item", opts) : explore("Open an item", opts);
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe.each(modes)("bounded page-guidance expiration in %s", mode => {
  it("stops a changing countdown after three expired decisions, with no click or application finding", async () => {
    expect(MAX_PAGE_GUIDANCE_EXPIRATIONS).toBe(3);
    const driver = new ChangingPage();
    driver.unstable = true;
    const llm = new Decisions();
    const { events, trace } = traced();
    const result = await run(mode, driver, llm, { trace });
    expect(result).toMatchObject({ truncated: true, truncationReason: "page-guidance-expired" });
    expect(llm.decisions).toHaveLength(3);
    expect(llm.proposals).toBe(mode === "discover" ? 1 : 0);
    expect(driver.clicked).toEqual([]);
    expect(result.steps).toEqual([{ kind: "goto", url: START }]);
    if ("findings" in result) expect(result.findings).toEqual([]);
    expect(terminalGates(events)).toHaveLength(1);
    expect(terminalGates(events)[0]).toMatchObject({ expirations: 3, limit: 3 });
    const diagnostics = JSON.stringify(guidanceGates(events));
    for (const privateText of [START, "Private guidance", "Private countdown", "Open item", "private-driver-ref"]) {
      expect(diagnostics).not.toContain(privateText);
    }
    expect(events.some(event => event.kind === "gate" && event.payload.gate === "no-progress")).toBe(false);
  });

  it("counts expiration at the later pre-dispatch URL check too", async () => {
    const driver = new ChangingPage();
    let reads = 0;
    let armed = false;
    driver.afterObserve = () => {
      if (armed && ++reads === 3) { armed = false; driver.url = `${START}?turn=${llm.decisions.length}`; }
    };
    const llm = new Decisions(() => { reads = 0; armed = true; return CLICK; });
    const { events, trace } = traced();
    const result = await run(mode, driver, llm, { trace });
    expect(result).toMatchObject({ truncated: true, truncationReason: "page-guidance-expired" });
    expect(llm.decisions).toHaveLength(3);
    expect(driver.clicked).toEqual([]);
    expect(guidanceGates(events).filter(payload => payload.reason.includes("URL changed"))).toHaveLength(3);
    expect(terminalGates(events)).toHaveLength(1);
  });

  it("recovers after a transient change without adding a termination reason", async () => {
    const driver = new ChangingPage();
    const llm = new Decisions(n => { driver.unstable = n === 1; return n < 3 ? CLICK : DONE; });
    const { events, trace } = traced();
    const result = await run(mode, driver, llm, { trace });
    expect(result.truncated).not.toBe(true);
    expect(result.truncationReason).toBeUndefined();
    expect(driver.clicked).toEqual(["Open item"]);
    expect(llm.decisions).toHaveLength(3);
    expect(terminalGates(events)).toEqual([]);
  });

  it("resets only after a successful action and preserves that action when later expirations stop the run", async () => {
    const driver = new ChangingPage();
    const llm = new Decisions(n => { driver.unstable = n !== 3; return CLICK; });
    const result = await run(mode, driver, llm);
    expect(result).toMatchObject({ truncated: true, truncationReason: "page-guidance-expired" });
    expect(llm.decisions).toHaveLength(6); // two expirations, a successful click, then three expirations
    expect(driver.clicked).toEqual(["Open item"]);
    expect(result.steps.filter(step => step.kind === "click")).toHaveLength(1);
  });

  it.each(["parse", "reference", "ambiguity", "policy", "dispatch"] as const)(
    "does not reset expiration history for an intervening %s failure", async failure => {
      const driver = new ChangingPage();
      driver.duplicate = failure === "ambiguity";
      const llm = new Decisions(n => {
        const gap = n % 2 === 0;
        driver.unstable = !gap;
        driver.failClicks = gap && failure === "dispatch";
        if (!gap) return '{"action":"click","text":"Open item","role":"link","nth":0}';
        if (failure === "parse") return "not JSON";
        if (failure === "reference") return '{"action":"click","ref":"invented"}';
        return CLICK;
      });
      const result = await run(mode, driver, llm, {
        policy: { vet: () => failure === "policy" ? { ok: false, reason: "Not allowed" } : { ok: true } },
      });
      expect(result).toMatchObject({ truncated: true, truncationReason: "page-guidance-expired" });
      expect(llm.decisions).toHaveLength(5);
      expect(driver.clicked).toEqual([]);
    },
  );

  it("does not let stale done decisions bypass the expiration bound", async () => {
    const driver = new ChangingPage();
    driver.unstable = true;
    const llm = new Decisions(() => DONE);
    const result = await run(mode, driver, llm);
    expect(result).toMatchObject({ truncated: true, truncationReason: "page-guidance-expired" });
    expect(llm.decisions).toHaveLength(3);
  });

  it.each(["absent", "failed", "timeout"] as const)(
    "keeps the no-guidance fallback for %s output and lets an executed action reset expiration history", async fallback => {
      if (fallback === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const driver = new ChangingPage();
      let requests = 0;
      const llm = new Decisions(n => n === 6 ? DONE : CLICK);
      const execution = run(mode, driver, llm, { pageGuidance: () => {
        requests++;
        driver.unstable = requests !== 6;
        if (requests === 3) {
          if (fallback === "absent") return undefined;
          if (fallback === "failed") throw new Error("private provider error");
          return new Promise<string>(resolve => setTimeout(() => resolve("late guidance"), PAGE_GUIDANCE_TIMEOUT_MS * 2));
        }
        return "Private guidance";
      } });
      if (fallback === "timeout") await vi.runAllTimersAsync();
      const result = await execution;
      expect(result.truncated).not.toBe(true);
      expect(result.truncationReason).toBeUndefined();
      expect(llm.decisions).toHaveLength(6);
      expect(driver.clicked).toEqual(["Open item"]);
      expect(llm.decisions[2]!.system).not.toContain("Host page guidance");
    },
  );

  it("does not turn an unguided changing page into guidance expiration", async () => {
    const driver = new ChangingPage();
    driver.unstable = true;
    const llm = new Decisions(n => n === 2 ? DONE : CLICK);
    const result = await run(mode, driver, llm, { pageGuidance: undefined });
    expect(result.truncated).not.toBe(true);
    expect(result.truncationReason).toBeUndefined();
    expect(driver.clicked).toEqual(["Open item"]);
    expect(llm.decisions).toHaveLength(2);
  });

  it.each(["absent", "failed", "timeout"] as const)(
    "does not clear expiration history merely because the provider is %s", async fallback => {
      if (fallback === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const driver = new ChangingPage();
      let requests = 0;
      const llm = new Decisions(n => n % 2 ? CLICK : "not JSON");
      const execution = run(mode, driver, llm, { pageGuidance: () => {
        driver.unstable = ++requests % 2 !== 0;
        if (!driver.unstable) {
          if (fallback === "absent") return undefined;
          if (fallback === "failed") throw new Error("provider unavailable");
          return new Promise<string>(resolve => setTimeout(() => resolve("late"), PAGE_GUIDANCE_TIMEOUT_MS * 2));
        }
        return "Private guidance";
      } });
      if (fallback === "timeout") await vi.runAllTimersAsync();
      const result = await execution;
      expect(result).toMatchObject({ truncated: true, truncationReason: "page-guidance-expired" });
      expect(llm.decisions).toHaveLength(5);
      expect(driver.clicked).toEqual([]);
    },
  );

  it.each([false, true])("bases retry advice on current references as capability changes (initial refs=%s)", async initialRefs => {
    const driver = new ChangingPage();
    driver.refs = initialRefs;
    const llm = new Decisions(n => {
      driver.unstable = n < 3;
      driver.refs = n === 1 ? !initialRefs : initialRefs;
      return n < 3 ? CLICK : DONE;
    });
    const result = await run(mode, driver, llm);
    expect(result.truncated).not.toBe(true);
    expect(llm.decisions[0]!.prompt).not.toContain("After page guidance expires");
    for (const [index, hasRefs] of [[1, !initialRefs], [2, initialRefs]] as const) {
      const prompt = llm.decisions[index]!.prompt;
      if (hasRefs) {
        expect(prompt).toMatch(/fresh "ref" from the current element listing/);
        expect(prompt).toContain("done and note do not take refs");
      } else {
        expect(prompt).toContain("No references are available");
        expect(prompt).not.toMatch(/fresh "ref" from the current element listing/);
      }
    }
  });

  it("can recover with a current exact reference without recapturing its snapshot before dispatch", async () => {
    const driver = new ChangingPage();
    driver.refs = true;
    let snapshotsAtDecision = 0;
    let snapshotsAtDispatch = 0;
    const click = driver.click.bind(driver);
    driver.click = async (target, ref) => { snapshotsAtDispatch = driver.snapshots; await click(target, ref); };
    const llm = new Decisions((n, prompt) => {
      driver.unstable = n < 3;
      if (n === 2) {
        snapshotsAtDecision = driver.snapshots;
        return JSON.stringify({ action: "click", ref: prompt.match(/ref="([^"]+)"/)![1] });
      }
      return n === 1 ? CLICK : DONE;
    });
    const result = await run(mode, driver, llm);
    expect(result.truncated).not.toBe(true);
    expect(driver.exact).toEqual(["private-driver-ref"]);
    expect(snapshotsAtDispatch).toBe(snapshotsAtDecision);
    expect(driver.clicked).toEqual(["Open item"]);
  });

  it.each(["contradictory", "expired", "driver-mutated"] as const)(
    "retains %s reference rejection during expiration recovery", async rejected => {
      const driver = new ChangingPage();
      driver.refs = true;
      if (rejected === "driver-mutated") driver.locateRef = async () => { throw new Error("observed node changed"); };
      let firstRef: string | undefined;
      const llm = new Decisions((n, prompt) => {
        driver.unstable = n % 2 !== 0;
        const ref = prompt.match(/ref="([^"]+)"/)![1]!;
        firstRef ??= ref;
        if (n % 2) return CLICK;
        return JSON.stringify({ action: "click", ref: rejected === "expired" ? firstRef : ref,
          ...(rejected === "contradictory" ? { text: "A different control" } : {}) });
      });
      const result = await run(mode, driver, llm);
      expect(result).toMatchObject({ truncated: true, truncationReason: "page-guidance-expired" });
      expect(llm.decisions).toHaveLength(5);
      expect(driver.clicked).toEqual([]);
      expect(driver.exact).toEqual([]);
    },
  );

  it("starts a new invocation with an empty expiration history", async () => {
    const driver = new ChangingPage();
    driver.unstable = true;
    expect((await run(mode, driver, new Decisions())).truncationReason).toBe("page-guidance-expired");
    const llm = new Decisions(n => { driver.unstable = n !== 2; return n === 2 ? DONE : CLICK; });
    const result = await run(mode, driver, llm);
    expect(result.truncated).not.toBe(true);
    expect(result.truncationReason).toBeUndefined();
    expect(llm.decisions).toHaveLength(2);
  });

  it.each([3, 20])("lets a trusted policy goal on the next fresh observation win at maxSteps=%s", async maxSteps => {
    const driver = new ChangingPage();
    driver.unstable = true;
    const llm = new Decisions();
    const { events, trace } = traced();
    const result = await run(mode, driver, llm, { maxSteps, trace,
      policy: { vet: () => ({ ok: true }), stop: () => llm.decisions.length === 3 },
    });
    expect(result.truncated).not.toBe(true);
    expect(result.truncationReason).toBeUndefined();
    expect(llm.decisions).toHaveLength(3);
    expect(terminalGates(events)).toEqual([]);
  });

  it.each([3, 20].flatMap(maxSteps => [false, true].map(completed => ({ maxSteps, completed }))))(
    "uses perceived goal state after the limit (completed=$completed, maxSteps=$maxSteps)", async ({ maxSteps, completed }) => {
      const llm = new Decisions();
      const finalCaptureOptions: (SnapshotOptions | undefined)[] = [];
      class GoalPage extends ChangingPage {
        override async snapshot(options?: SnapshotOptions): Promise<PageElement[]> {
          if (llm.decisions.length === 3) finalCaptureOptions.push(options);
          return [...await super.snapshot(), { role: "checkbox", name: "Complete", checked: !completed }];
        }
      }
      const driver = new GoalPage();
      driver.unstable = true;
      const { events, trace } = traced();
      const result = await run(mode, driver, llm, { maxSteps, trace,
        perceive: async rows => rows.map(row => row.role === "checkbox"
          ? { ...row, checked: llm.decisions.length === 3 && completed } : row),
        policy: { vet: () => ({ ok: true }), stop: (_steps, ctx) =>
          Boolean(ctx?.elements.some(row => row.role === "checkbox" && row.checked)) },
      });
      expect(llm.decisions).toHaveLength(3);
      expect(driver.clicked).toEqual([]);
      if (completed) {
        expect(result.truncated).not.toBe(true);
        expect(result.truncationReason).toBeUndefined();
        expect(terminalGates(events)).toEqual([]);
      } else {
        expect(result).toMatchObject({ truncated: true, truncationReason: "page-guidance-expired" });
        expect(terminalGates(events)).toHaveLength(1);
      }
      expect(finalCaptureOptions).toHaveLength(2); // the last validation and the observation-only goal check
      expect(finalCaptureOptions.every(options => options?.perception === true)).toBe(true);
    },
  );

  it.each([3, 20])("rejects a changed reference binding in the final perceived goal at maxSteps=%s", async maxSteps => {
    const driver = new ChangingPage();
    driver.refs = true;
    driver.unstable = true;
    const llm = new Decisions();
    const { events, trace } = traced();
    const stop = vi.fn(() => llm.decisions.length === 3);
    const result = await run(mode, driver, llm, { maxSteps, trace,
      perceive: async rows => rows.map(row => llm.decisions.length === 3 && row.ref
        ? { ...row, name: "Changed bound name" } : row),
      policy: { vet: () => ({ ok: true }), stop },
    });
    expect(result).toMatchObject({ truncated: true, truncationReason: "page-guidance-expired" });
    expect(stop).toHaveBeenCalledTimes(3); // the invalid final capture cannot authorize completion
    expect(driver.clicked).toEqual([]);
    expect(events.some(event => event.kind === "gate" && event.payload.gate === "perception-binding")).toBe(true);
    expect(terminalGates(events)).toHaveLength(1);
  });

  it("keeps guidance expiration distinct when the real scroll policy also exhausts recovery", async () => {
    let changingOrder = false;
    let reverse = false;
    class ScrollPage extends ChangingPage {
      async scrollState() {
        return { region: "document", x: 0, y: 0, width: 800, height: 600, scrollWidth: 800, scrollHeight: 1200 };
      }
      override async snapshot(): Promise<PageElement[]> {
        const rows = await super.snapshot();
        // Row order invalidates guidance, but the scroll policy compares semantic multisets.
        if (changingOrder) reverse = !reverse;
        return reverse ? rows.reverse() : rows;
      }
    }
    const driver = new ScrollPage();
    const llm = new Decisions(n => {
      changingOrder = n > 1;
      return n === 1 ? '{"action":"scroll","direction":"down"}' : CLICK;
    });
    const scroll = createScrollNoProgressPolicy({ tolerance: 1, recoveryTurns: 3 }).createRun!();
    const { events, trace } = traced();
    const result = await run(mode, driver, llm, { trace, policy: { ...scroll, stop: () => false } });
    expect(llm.decisions).toHaveLength(4);
    expect(scroll.incomplete?.()).toMatchObject({ halt: true,
      diagnostic: { code: "no-progress", repeatedTransitions: 1, recoveryTurns: 3 } });
    expect(result).toMatchObject({ truncated: true, truncationReason: "page-guidance-expired" });
    expect(terminalGates(events)).toHaveLength(1);
    expect(events.some(event => event.kind === "gate" && event.payload.gate === "no-progress")).toBe(false);
    expect(driver.clicked).toEqual([]);
    expect(result.steps.filter(step => step.kind === "scroll")).toHaveLength(mode === "explore" ? 1 : 0);
  });

  it.each([3, 20].flatMap(maxSteps => ["provider", "model"].map(during => ({ maxSteps, during }))))(
    "uses the fresh URL for trusted completion after $during navigation at maxSteps=$maxSteps", async ({ maxSteps, during }) => {
      const driver = new ChangingPage();
      const goal = "https://private.example/goal";
      const destination = (n: number) => n === 3 ? goal : `${START}?turn=${n}`;
      let requests = 0;
      const llm = new Decisions(n => { if (during === "model") driver.url = destination(n); return CLICK; });
      const { events, trace } = traced();
      const seenUrls: (string | undefined)[] = [];
      const result = await run(mode, driver, llm, { maxSteps, trace,
        pageGuidance: () => {
          if (during === "provider") driver.url = destination(++requests);
          return "Private guidance";
        },
        policy: { vet: () => ({ ok: true }), stop: (_steps, ctx) => {
          seenUrls.push(ctx?.url);
          return ctx?.url === goal;
        } },
      });
      expect(result.truncated).not.toBe(true);
      expect(result.truncationReason).toBeUndefined();
      expect(llm.decisions).toHaveLength(3);
      expect(driver.clicked).toEqual([]);
      expect(seenUrls.at(-1)).toBe(goal);
      expect(terminalGates(events)).toEqual([]);
    },
  );

  it.each([1, 2])("does not claim the expiration bound when the general step cap is only %s", async maxSteps => {
    const driver = new ChangingPage();
    driver.unstable = true;
    const llm = new Decisions();
    const { events, trace } = traced();
    const result = await run(mode, driver, llm, { maxSteps, trace });
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBeUndefined();
    expect(llm.decisions).toHaveLength(maxSteps);
    expect(terminalGates(events)).toEqual([]);
  });

  it.each([3, 20].flatMap(maxSteps => ["settle", "observe", "snapshot"].map(read => ({ maxSteps, read }))))(
    "preserves cancellation when the post-limit policy $read fails at maxSteps=$maxSteps", async ({ maxSteps, read }) => {
      const driver = new ChangingPage();
      const controller = new AbortController();
      const reason = new Error("stop during the final policy observation");
      const abortRead = () => { controller.abort(reason); throw new Error("browser read also failed"); };
      const llm = new Decisions(n => { driver.url = `${START}?turn=${n}`; return CLICK; });
      if (read === "settle") driver.settle = async () => { if (llm.decisions.length === 3) abortRead(); };
      if (read === "snapshot") driver.afterSnapshot = () => { if (llm.decisions.length === 3) abortRead(); };
      if (read === "observe") {
        let afterLastDecision = 0;
        driver.afterObserve = () => {
          // The first read rejects the third guided decision's changed URL. The second belongs
          // to the observation-only policy goal check, after the expiration limit was reached.
          if (llm.decisions.length === 3 && ++afterLastDecision === 2) abortRead();
        };
      }
      const { events, trace } = traced();
      await expect(run(mode, driver, llm, { maxSteps, signal: controller.signal, trace,
        policy: { vet: () => ({ ok: true }), stop: () => false },
      })).rejects.toBe(reason);
      expect(llm.decisions).toHaveLength(3);
      expect(llm.proposals).toBe(0);
      expect(driver.clicked).toEqual([]);
      expect(terminalGates(events)).toEqual([]);
    },
  );

  it("preserves caller cancellation during the final invalidation read", async () => {
    const driver = new ChangingPage();
    driver.unstable = true;
    const controller = new AbortController();
    const reason = new Error("stop now");
    const llm = new Decisions();
    driver.afterSnapshot = () => { if (llm.decisions.length === 3) controller.abort(reason); };
    const { events, trace } = traced();
    await expect(run(mode, driver, llm, { signal: controller.signal, trace })).rejects.toBe(reason);
    expect(driver.clicked).toEqual([]);
    expect(terminalGates(events)).toEqual([]);
    expect(llm.proposals).toBe(0);
  });

  it("keeps model-budget exhaustion distinct from expiration", async () => {
    const driver = new ChangingPage();
    driver.unstable = true;
    const llm = new Decisions();
    const { events, trace } = traced();
    const error = await run(mode, driver, llm, { budget: { maxModelCalls: 2 }, trace }).catch(error => error);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error.budget).toMatchObject({ limit: "model-calls", modelCalls: 2 });
    expect(llm.decisions).toHaveLength(2);
    expect(terminalGates(events)).toEqual([]);
  });

  it.each([false, true])("preserves cancellation during the late pre-dispatch URL read (read rejects=%s)", async rejects => {
    const driver = new ChangingPage();
    const controller = new AbortController();
    const reason = new Error("cancel before dispatch");
    let reads = 0;
    let armed = false;
    driver.afterObserve = () => {
      if (armed && ++reads === 3) {
        controller.abort(reason);
        if (rejects) throw new Error("read also failed");
      }
    };
    const llm = new Decisions(() => { reads = 0; armed = true; return CLICK; });
    const { events, trace } = traced();
    await expect(run(mode, driver, llm, { signal: controller.signal, trace })).rejects.toBe(reason);
    expect(driver.clicked).toEqual([]);
    expect(terminalGates(events)).toEqual([]);
    expect(llm.proposals).toBe(0);
  });

  it("preserves elapsed-time budget exhaustion during an invalidation capture", async () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const driver = new ChangingPage();
    driver.unstable = true;
    const llm = new Decisions();
    driver.afterSnapshot = () => { if (llm.decisions.length === 3) now += 1000; };
    const { events, trace } = traced();
    const error = await run(mode, driver, llm, { budget: { timeoutMs: 100 }, trace }).catch(error => error);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error.budget).toMatchObject({ limit: "time", modelCalls: 3 });
    expect(driver.clicked).toEqual([]);
    expect(terminalGates(events)).toEqual([]);
    expect(llm.proposals).toBe(0);
  });

  it("preserves elapsed-time budget exhaustion during the late URL check", async () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const driver = new ChangingPage();
    let reads = 0;
    let armed = false;
    driver.afterObserve = () => { if (armed && ++reads === 3) now += 1000; };
    const llm = new Decisions(() => { reads = 0; armed = true; return CLICK; });
    const { events, trace } = traced();
    const error = await run(mode, driver, llm, { budget: { timeoutMs: 100 }, trace }).catch(error => error);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error.budget).toMatchObject({ limit: "time", modelCalls: 1 });
    expect(driver.clicked).toEqual([]);
    expect(terminalGates(events)).toEqual([]);
    expect(llm.proposals).toBe(0);
  });
});

it.each([
  { maxSteps: 3, needsScrollState: false },
  { maxSteps: 20, needsScrollState: false },
  { maxSteps: 3, needsScrollState: true },
  { maxSteps: 20, needsScrollState: true },
])("retains the known URL for the final discovery goal at $maxSteps steps with needsScrollState=$needsScrollState", async ({ maxSteps, needsScrollState }) => {
  const driver = new ChangingPage();
  driver.unstable = true;
  const llm = new Decisions();
  const observe = driver.observe.bind(driver);
  driver.observe = async () => {
    const evidence = await observe();
    if (llm.decisions.length === 3) delete evidence.execution.finalUrl;
    return evidence;
  };
  const urls: (string | undefined)[] = [];
  const { events, trace } = traced();
  const result = await run("discover", driver, llm, { maxSteps, trace,
    policy: { needsScrollState, vet: () => ({ ok: true }), stop: (_steps, ctx) => {
      urls.push(ctx?.url);
      return llm.decisions.length === 3 && ctx?.url === START;
    } },
  });
  expect(llm.decisions).toHaveLength(3);
  expect(urls).toEqual([START, START, START, START]);
  expect(result.truncated).not.toBe(true);
  expect(result.truncationReason).toBeUndefined();
  expect(driver.clicked).toEqual([]);
  expect(terminalGates(events)).toEqual([]);
});

it.each([3, 20])("does not use the old goal URL over new evidence after expiration at maxSteps=%s", async maxSteps => {
  const driver = new ChangingPage();
  driver.unstable = true;
  const llm = new Decisions();
  const next = "https://private.example/other-page";
  const observe = driver.observe.bind(driver);
  driver.observe = async () => {
    const evidence = await observe();
    if (llm.decisions.length === 3) evidence.execution.finalUrl = next;
    return evidence;
  };
  const urls: (string | undefined)[] = [];
  const result = await run("discover", driver, llm, { maxSteps,
    policy: { vet: () => ({ ok: true }), stop: (_steps, ctx) => {
      urls.push(ctx?.url);
      return llm.decisions.length === 3 && ctx?.url === START;
    } },
  });
  expect(llm.decisions).toHaveLength(3);
  expect(urls).toEqual([START, START, START, next]);
  expect(result).toMatchObject({ truncated: true, truncationReason: "page-guidance-expired" });
  expect(driver.clicked).toEqual([]);
});

it("does not publish stale exploration notes or clear expiration history with accepted notes", async () => {
  for (const stableNotes of [false, true]) {
    const driver = new ChangingPage();
    const llm = new Decisions(n => {
      driver.unstable = !stableNotes || n % 2 !== 0;
      return '{"action":"note","text":"An observed issue"}';
    });
    const result = await run("explore", driver, llm);
    expect(result).toMatchObject({ truncated: true, truncationReason: "page-guidance-expired" });
    expect(llm.decisions).toHaveLength(stableNotes ? 5 : 3);
    if ("findings" in result) expect(result.findings).toHaveLength(stableNotes ? 1 : 0);
  }
});

it("counts discovery's final assertion proposal under the same model allowance", async () => {
  const driver = new ChangingPage();
  driver.unstable = true;
  const llm = new Decisions();
  const { events, trace } = traced();
  const error = await run("discover", driver, llm, { budget: { maxModelCalls: 3 }, trace }).catch(error => error);
  expect(error).toBeInstanceOf(BudgetExceededError);
  expect(error.budget.modelCalls).toBe(3);
  expect(llm.decisions).toHaveLength(3);
  expect(llm.proposals).toBe(0);
  expect(terminalGates(events)).toEqual([]);
  expect(events.filter(event => event.kind === "budget-exhausted")).toHaveLength(1);
});

it.each([3, 20])("slots secrets in the final discovery goal observation at maxSteps=%s", async maxSteps => {
  const driver = new ChangingPage();
  driver.unstable = true;
  const snapshot = driver.snapshot.bind(driver);
  driver.snapshot = async () => [...await snapshot(), { role: "textbox", name: "Private code", value: "abc-123" }];
  const llm = new Decisions();
  const goalViews: (string | undefined)[][] = [];
  const result = await run("discover", driver, llm, { maxSteps, secrets: { code: "abc-123" },
    policy: { vet: () => ({ ok: true }), stop: (_steps, ctx) => {
      goalViews.push(ctx!.elements.map(row => row.value));
      return llm.decisions.length === 3 && ctx!.elements.some(row => row.name === "Private code" && row.value === "{code}");
    } },
  });
  expect(llm.decisions).toHaveLength(3);
  expect(result.truncated).not.toBe(true);
  expect(goalViews).toHaveLength(4);
  expect(goalViews.every(values => values.includes("{code}"))).toBe(true);
  expect(JSON.stringify(goalViews)).not.toContain("abc-123");
});

it.each(["initial", "late"] as const)("retains the latest URL and visit when the %s URL check reaches the limit", async gate => {
  const driver = new ChangingPage();
  let reads = 0;
  let armed = false;
  const destination = (n: number) => `https://private.example/page-${n}`;
  driver.afterObserve = () => {
    if (armed && ++reads === (gate === "initial" ? 1 : 3)) {
      armed = false;
      driver.url = destination(llm.decisions.length);
    }
  };
  const llm = new Decisions(() => { reads = 0; armed = true; return CLICK; });
  const result = await run("explore", driver, llm);
  expect(llm.decisions).toHaveLength(3);
  expect(result).toMatchObject({ truncated: true, truncationReason: "page-guidance-expired",
    finalUrl: destination(3), visited: ["private.example/start", "private.example/page-1", "private.example/page-2", "private.example/page-3"] });
  expect(driver.clicked).toEqual([]);
  // The metadata comes from reads already made by the gates, not a new terminal browser read.
  expect(driver.observations).toBe(gate === "initial" ? 6 : 12);
});
