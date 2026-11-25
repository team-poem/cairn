import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetExceededError, discover, explore } from "../src/index.js";
import type { DiscoverOptions, ExploreOptions, PageGuidanceProvider, TraceEvent } from "../src/index.js";
import { startTrace } from "../src/core/trace.js";
import { StubDriver } from "./support/doubles.js";

const START = "https://example.test/list";
const DETAIL = "https://example.test/detail";
const DONE = '{"action":"done"}';
type Mode = "discover" | "explore";

function fixture(mode: Mode, reply: (prompt: string) => string = () => DONE, driver = new StubDriver(START)) {
  const decisions: string[] = [];
  let proposals = 0;
  const llm = { id: "preflight", async complete(prompt: string) {
    if (prompt.includes("Propose the verification assertions.")) { proposals++; return "[]"; }
    decisions.push(prompt);
    return reply(prompt);
  } };
  const events: TraceEvent[] = [];
  const trace = startTrace({ emit: event => { events.push(event); } }, "preflight").scope("case");
  const run = (pageGuidance?: PageGuidanceProvider, extra: Partial<DiscoverOptions & ExploreOptions> = {}) => {
    const opts = { driver, llm, baseUrl: START, pageGuidance, trace, maxSteps: 10, ...extra };
    return mode === "discover" ? discover("Inspect the item", opts) : explore("Inspect the item", opts);
  };
  return { driver, run, events, decisions, get proposals() { return proposals; } };
}

afterEach(() => vi.restoreAllMocks());

describe.each(["discover", "explore"] as const)("%s guided decision admission", mode => {
  it("expires guided input when target lookup moves to a different URL", async () => {
    const driver = new StubDriver(START);
    driver.els = [{ role: "button", name: "Save" }];
    let lookups = 0;
    driver.locate = async target => {
      driver.url = `https://example.test/page-${++lookups}`;
      return target;
    };
    const f = fixture(mode, () => '{"action":"click","role":"button","text":"Save"}', driver);
    const onOutcome = vi.fn();
    const result = await f.run(() => "Use the visible Save control", { actionOutcomes: { onOutcome } });
    expect(result).toMatchObject({ truncated: true, truncationReason: "page-guidance-expired" });
    expect(lookups).toBe(3);
    expect(driver.clicked).toEqual([]);
    expect(result.steps.map(step => step.kind)).toEqual(["goto"]);
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it.each(["cancel", "transport"] as const)("does not dispatch or decide again after %s during the pre-input outcome read", async cause => {
    const driver = new StubDriver(START);
    driver.els = [{ role: "button", name: "Save" }];
    const controller = new AbortController();
    const failure = cause === "transport" ? Object.assign(new Error("browser disconnected"), { kind: "transport" })
      : new Error("host stopped before input");
    let located = false, preInputReads = 0;
    driver.locate = async target => { located = true; return target; };
    const observe = driver.observe.bind(driver);
    driver.observe = async () => {
      const evidence = await observe();
      if (located) {
        preInputReads++;
        if (cause === "transport") throw failure;
        controller.abort(failure);
      }
      return evidence;
    };
    const f = fixture(mode, () => '{"action":"click","role":"button","text":"Save"}', driver);
    const onOutcome = vi.fn();
    await expect(f.run(undefined, { actionOutcomes: { onOutcome }, signal: controller.signal })).rejects.toBe(failure);
    expect(preInputReads).toBe(1);
    expect(f.decisions).toHaveLength(1);
    expect(driver.clicked).toEqual([]);
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it("discards stale guidance and elements, then acts on a fresh observation", async () => {
    const driver = new class extends StubDriver {
      async locateRef(ref: string) {
        if (ref !== "detail-ref") throw new Error("unexpected reference");
        return { text: "New item", role: "link" };
      }
    }(START);
    const click = vi.spyOn(driver, "click");
    const f = fixture(mode, prompt => driver.clicked.length ? DONE :
      JSON.stringify({ action: "click", ref: prompt.match(/ref="([^"]+)"/)![1] }), driver);
    driver.els = [{ role: "link", name: "Old item", ref: "list-ref" }];
    const ids: string[] = [];
    const result = await f.run(request => {
      ids.push(request.observationId);
      if (request.url === START) {
        f.driver.url = DETAIL;
        driver.els = [{ role: "link", name: "New item", ref: "detail-ref" }];
        return "Advice for the old item";
      }
      return "Advice for the new item";
    });
    expect(result.truncated).not.toBe(true);
    expect(f.driver.clicked).toEqual(["New item"]);
    expect(click).toHaveBeenCalledWith(expect.objectContaining({ text: "New item" }), "detail-ref");
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(f.decisions).toHaveLength(2);
    expect(f.decisions[0]).toContain("Advice for the new item");
    expect(f.decisions[0]).toContain("New item");
    expect(f.decisions.join(" ")).not.toMatch(/Advice for the old item|Old item/);
    expect(f.events.filter(e => e.kind === "selection")).toHaveLength(2);
    expect(f.proposals).toBe(mode === "discover" ? 1 : 0);
  });

  it.each([2, 3, 10])("bounds pre-call discards without charging a model admission (maxSteps=%i)", async maxSteps => {
    const f = fixture(mode);
    let providers = 0;
    const result = await f.run(() => {
      f.driver.url = `https://example.test/private-${++providers}`;
      return "Private advice";
    }, { maxSteps, budget: { maxModelCalls: 1 } });
    expect(providers).toBe(Math.min(3, maxSteps));
    expect(f.decisions).toEqual([]);
    expect(f.driver.clicked).toEqual([]);
    expect(f.proposals).toBe(mode === "discover" ? 1 : 0);
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe(maxSteps >= 3 ? "page-guidance-expired" : undefined);
    if ("visited" in result) expect(result.finalUrl).toBe(f.driver.url);
    expect(f.events.filter(e => e.kind === "selection")).toEqual([]);
    const gates = f.events.flatMap(e => e.kind === "gate" && e.payload.gate === "page-guidance" ? [e.payload] : []);
    expect(gates.filter(g => !g.code)).toHaveLength(providers);
    expect(JSON.stringify(gates)).not.toMatch(/private-|example\.test|Private advice/);
  });

  it.each([
    { name: "fresh URL, empty retry guidance", entry: START, preflight: DETAIL, retry: DETAIL, advice: undefined },
    { name: "missing retry URL, fresh guidance", entry: START, preflight: DETAIL, retry: undefined, advice: "Detail hint" },
    { name: "known URL disappears before admission", entry: START, preflight: undefined, retry: DETAIL, advice: "Detail hint" },
    { name: "missing URL appears before admission", entry: undefined, preflight: DETAIL, retry: DETAIL, advice: "Detail hint" },
  ])("uses the retry observation after expiry: $name", async ({ entry, preflight, retry, advice }) => {
    const f = fixture(mode);
    f.driver.els = [{ role: "button", name: "List control" }];
    const observe = f.driver.observe.bind(f.driver);
    let reportedUrl = entry;
    let firstPreflight = false;
    f.driver.observe = async () => {
      const evidence = await observe();
      if (reportedUrl === undefined) delete evidence.execution.finalUrl;
      else evidence.execution.finalUrl = reportedUrl;
      if (firstPreflight) {
        firstPreflight = false;
        reportedUrl = retry;
      }
      return evidence;
    };
    const providerUrls: (string | undefined)[] = [];
    const policyUrls: (string | undefined)[] = [];
    const result = await f.run(request => {
      providerUrls.push(request.url);
      if (providerUrls.length === 1) {
        f.driver.els = [{ role: "button", name: "Detail control" }];
        reportedUrl = preflight;
        firstPreflight = true;
        return "List hint";
      }
      return advice;
    }, { policy: { vet: () => ({ ok: true }), stop: (_steps, ctx) => {
      policyUrls.push(ctx?.url);
      return false;
    } } });
    expect(providerUrls).toEqual([entry, retry]);
    expect(f.decisions).toHaveLength(1);
    const prompt = f.decisions[0]!;
    expect(prompt.split("\n")).toContain(`Current page: ${retry ?? "(unknown)"}`);
    expect(prompt).toContain("Detail control");
    expect(prompt).not.toMatch(/List control|List hint/);
    if (advice) expect(prompt).toContain(advice);
    expect(policyUrls.at(-1)).toBe(DETAIL);
    if ("visited" in result) expect(result.finalUrl).toBe(DETAIL);
    expect(result.truncated).not.toBe(true);
    expect(f.driver.clicked).toEqual([]);
    expect(f.proposals).toBe(mode === "discover" ? 1 : 0);
  });

  it("shares the expiration bound across pre-call and post-response URL changes", async () => {
    const f = fixture(mode, () => {
      f.driver.url = DETAIL;
      return DONE;
    });
    let providers = 0;
    const result = await f.run(() => {
      providers++;
      if (providers !== 2) f.driver.url = `${START}?turn=${providers}`;
      return "Inspect this page";
    });
    expect(providers).toBe(3);
    expect(result.truncationReason).toBe("page-guidance-expired");
    expect(f.decisions).toHaveLength(1);
    expect(f.driver.clicked).toEqual([]);
  });

  it.each([true, false])("adds only one pre-call observe for accepted guidance (accepted=%s)", async accepted => {
    let countAtProvider = -1;
    let preCallReads = -1;
    const f = fixture(mode, () => { preCallReads = observe.mock.calls.length - countAtProvider; return DONE; });
    const observe = vi.spyOn(f.driver, "observe");
    await f.run(() => { countAtProvider = observe.mock.calls.length; return accepted ? "Inspect this page" : undefined; });
    expect(preCallReads).toBe(accepted ? 1 : 0);
  });

  it("keeps post-response checks when the Driver never supplies a URL", async () => {
    const f = fixture(mode, () => {
      if (f.decisions.length === 1) f.driver.els = [{ role: "heading", name: "New screen" }];
      return DONE;
    });
    const observe = f.driver.observe.bind(f.driver);
    f.driver.observe = async () => {
      const evidence = await observe();
      delete evidence.execution.finalUrl;
      return evidence;
    };
    const result = await f.run(() => "Inspect the screen");
    expect(result.truncated).not.toBe(true);
    expect(f.decisions).toHaveLength(2);
    expect(f.decisions[1]).toContain("New screen");
  });

  it.each(["abort", "abort-and-reject", "deadline"] as const)("preserves %s during the admission read", async stop => {
    const controller = new AbortController();
    const reason = new Error("stopped during preflight");
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const f = fixture(mode);
    const observe = f.driver.observe.bind(f.driver);
    let ready = false;
    f.driver.observe = async () => {
      if (ready) {
        if (stop === "deadline") now += 1000;
        else controller.abort(reason);
        if (stop === "abort-and-reject") throw new Error("read also failed");
      }
      return observe();
    };
    const result = f.run(() => { ready = true; return "Inspect this page"; }, {
      signal: controller.signal, ...(stop === "deadline" ? { budget: { timeoutMs: 100 } } : {}),
    });
    if (stop === "deadline") {
      const error: unknown = await result.catch(e => e);
      expect(error).toBeInstanceOf(BudgetExceededError);
      expect(error).toMatchObject({ budget: { limit: "time", modelCalls: 0 } });
    } else await expect(result).rejects.toBe(reason);
    expect(f.decisions).toEqual([]);
    expect(f.proposals).toBe(0);
    expect(f.driver.clicked).toEqual([]);
    expect(f.events.filter(e => e.kind === "gate" && e.payload.gate === "page-guidance")).toEqual([]);
  });
});
