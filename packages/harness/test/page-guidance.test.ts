import { afterEach, describe, expect, it, vi } from "vitest";
import { discover, explore, runScenario, BudgetExceededError, MAX_PAGE_GUIDANCE_BYTES, PAGE_GUIDANCE_TIMEOUT_MS } from "../src/index.js";
import type { CompleteOptions, Evidence, LlmClient, PageElement, PageGuidanceProvider, PageGuidanceRequest, Scenario, Target, TraceEvent } from "../src/index.js";
import { startTrace } from "../src/core/trace.js";
import { StubDriver } from "./support/doubles.js";

const START = "https://app/start";
const TWO = "https://app/two";
const silent = { emit: async () => {} };

class Pages extends StubDriver {
  pages: Record<string, PageElement[]> = {
    [START]: [{ role: "button", name: "Next" }],
    [TWO]: [{ role: "button", name: "Finish" }],
  };
  constructor() {
    super(START);
    this.navOn.Next = TWO;
  }
  override async snapshot(): Promise<PageElement[]> {
    return this.pages[this.url] ?? [];
  }
}

class RecordingLlm implements LlmClient {
  id = "scripted";
  calls: { prompt: string; system?: string }[] = [];
  constructor(private replies: string[]) {}
  async complete(prompt: string, opts?: CompleteOptions) {
    this.calls.push({ prompt, system: opts?.system });
    return this.replies.shift() ?? "[]";
  }
}

const twoPageReplies = () => [
  '{"action":"click","text":"Next","reason":"go on"}',
  '{"action":"click","text":"Finish","reason":"finish"}',
  '{"action":"done"}',
  "[]",
];
const section = (text: string) => JSON.stringify(text);
const traced = () => {
  const events: TraceEvent[] = [];
  return { events, scope: startTrace({ emit: (e) => { events.push(e); } }, "0.0.0").scope("case") };
};
const gates = (events: TraceEvent[]) =>
  events.flatMap(e => e.kind === "gate" && e.payload.gate === "page-guidance" ? [e.payload.reason] : []);

afterEach(() => { vi.useRealTimers(); });

describe("page guidance bound to a decision observation", () => {
  it("guides each page of a two-page flow with that page's own observation, then replays without it", async () => {
    const requests: PageGuidanceRequest[] = [];
    const provider: PageGuidanceProvider = (request) => { requests.push(request); return `Guide for ${request.url}`; };
    const llm = new RecordingLlm(twoPageReplies());
    const frozen = await discover("Finish the wizard", { driver: new Pages(), llm, baseUrl: START, pageGuidance: provider });

    expect(requests.map(r => [r.purpose, r.url, r.elements])).toEqual([
      ["discover", START, [{ role: "button", name: "Next" }]],
      ["discover", TWO, [{ role: "button", name: "Finish" }]],
      ["discover", TWO, [{ role: "button", name: "Finish" }]],
    ]);
    expect(new Set(requests.map(r => r.observationId)).size).toBe(3);
    expect(llm.calls[0]!.prompt).toContain(section(`Guide for ${START}`));
    expect(llm.calls[1]!.prompt).toContain(section(`Guide for ${TWO}`));
    expect(llm.calls[1]!.prompt).not.toContain(section(`Guide for ${START}`));
    expect(llm.calls[0]!.prompt.trimEnd().endsWith("Respond with JSON only.")).toBe(true);
    expect(llm.calls[0]!.system).toContain("Host page guidance");
    // The assertion proposal is the last call and never receives guidance.
    expect(llm.calls.at(-1)!.prompt).not.toContain("Guide for");
    expect(llm.calls.at(-1)!.system ?? "").not.toContain("Host page guidance");

    const unguided = await discover("Finish the wizard", { driver: new Pages(), llm: new RecordingLlm(twoPageReplies()), baseUrl: START });
    expect(frozen).toEqual(unguided);
    expect(JSON.stringify(frozen)).not.toContain("Guide");

    const noModel: LlmClient = { id: "none", complete: async () => { throw new Error("replay must not call a model"); } };
    const replay = await runScenario(frozen, { driver: new Pages(), llm: noModel, reporter: silent });
    expect(replay.result.verdict.passed).toBe(true);
    expect(replay.result.usage?.llmCalls ?? 0).toBe(0);
  });

  it("leaves prompts unchanged when the provider has nothing to say", async () => {
    const guided = new RecordingLlm(twoPageReplies());
    const plain = new RecordingLlm(twoPageReplies());
    await discover("Finish the wizard", { driver: new Pages(), llm: guided, baseUrl: START, pageGuidance: () => undefined });
    await discover("Finish the wizard", { driver: new Pages(), llm: plain, baseUrl: START });
    expect(guided.calls).toEqual(plain.calls);
  });

  it("rebinds guidance when an overlay opens on the same URL", async () => {
    const driver = new Pages();
    driver.click = async (t) => {
      driver.clicked.push(t.text ?? "");
      if (t.text === "Next") driver.pages[START] = [{ role: "button", name: "Next" },
        { role: "dialog", name: "Filters", inActivePopup: true }, { role: "button", name: "Apply", inActivePopup: true }];
    };
    const requests: PageGuidanceRequest[] = [];
    const llm = new RecordingLlm(['{"action":"click","text":"Next"}', '{"action":"done"}', "[]"]);
    await discover("Filter", { driver, llm, baseUrl: START, pageGuidance: (r) => {
      requests.push(r);
      return r.elements.some(e => e.inActivePopup) ? "Filters overlay is open" : "No overlay";
    } });
    expect(requests.map(r => r.url)).toEqual([START, START]);
    expect(requests[0]!.observationId).not.toBe(requests[1]!.observationId);
    expect(requests[1]!.elements).toContainEqual({ role: "button", name: "Apply", inActivePopup: true });
    expect(llm.calls[0]!.prompt).toContain(section("No overlay"));
    expect(llm.calls[1]!.prompt).toContain(section("Filters overlay is open"));
    expect(llm.calls[1]!.prompt).not.toContain(section("No overlay"));
  });

  it("refuses to dispatch a guided decision after the page URL changed", async () => {
    const driver = new Pages();
    const { events, scope } = traced();
    let first = true;
    const llm = new RecordingLlm(['{"action":"click","text":"Next"}', '{"action":"done"}', "[]"]);
    await discover("Go", { driver, llm, baseUrl: START, trace: scope, pageGuidance: () => {
      if (first) { first = false; driver.url = TWO; } // navigation lands while the provider runs
      return "Click Next";
    } });
    expect(driver.clicked).toEqual([]);
    expect(gates(events)).toEqual(["page guidance expired: the page URL changed after the guided observation"]);
    expect(llm.calls[1]!.prompt).toContain("not run: the page changed after the observation it was decided on");
  });

  it.each(["provider", "model"] as const)("rejects a guided done after a same-URL overlay opens during the %s", async (during) => {
    const driver = new Pages();
    const { events, scope } = traced();
    const openOverlay = () => { driver.pages[START] = [{ role: "dialog", name: "Confirm", inActivePopup: true }]; };
    const llm = new RecordingLlm(['{"action":"done"}', '{"action":"done"}', "[]"]);
    const complete = llm.complete.bind(llm);
    llm.complete = async (prompt, options) => {
      const reply = await complete(prompt, options);
      if (during === "model" && llm.calls.length === 1) openOverlay();
      return reply;
    };
    let calls = 0;
    await discover("Go", { driver, llm, baseUrl: START, trace: scope, pageGuidance: () => {
      if (during === "provider" && calls === 0) openOverlay();
      calls++;
      return "Current page advice";
    } });
    expect(calls).toBe(2);
    expect(llm.calls).toHaveLength(3);
    expect(gates(events)).toEqual(["page guidance expired: the page elements changed after the guided observation"]);
    expect(events.filter(e => e.kind === "action" && e.payload.done)).toHaveLength(1);
  });

  it("rejects a guided done after navigation and captures guidance for the new page", async () => {
    const driver = new Pages();
    const requests: PageGuidanceRequest[] = [];
    const llm = new RecordingLlm(['{"action":"done"}', '{"action":"done"}', "[]"]);
    await discover("Go", { driver, llm, baseUrl: START, pageGuidance: request => {
      requests.push(request);
      if (requests.length === 1) driver.url = TWO;
      return "Current page advice";
    } });
    expect(requests.map(r => r.url)).toEqual([START, TWO]);
  });

  it("rejects a legacy name action when an overlay changes while guidance is pending", async () => {
    const driver = new Pages();
    let calls = 0;
    const llm = new RecordingLlm(['{"action":"click","text":"Next"}', '{"action":"done"}', "[]"]);
    await discover("Go", { driver, llm, baseUrl: START, pageGuidance: () => {
      if (calls++ === 0) driver.pages[START]!.push({ role: "dialog", name: "Confirm", inActivePopup: true });
      return "Click Next";
    } });
    expect(driver.clicked).toEqual([]);
    expect(calls).toBe(2);
  });

  it("does not publish an exploration note from an obsolete same-URL observation", async () => {
    const driver = new Pages();
    const llm = new RecordingLlm(['{"action":"note","text":"Stale finding"}', '{"action":"done"}']);
    let calls = 0;
    const report = await explore("Survey", { driver, llm, baseUrl: START, pageGuidance: () => {
      if (calls++ === 0) driver.pages[START] = [{ role: "dialog", name: "Confirm", inActivePopup: true }];
      return "Current page advice";
    } });
    expect(report.findings).toEqual([]);
    expect(calls).toBe(2);
  });

  it("drops a slow provider at the timeout and never applies its late value", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const signals: AbortSignal[] = [];
    let calls = 0;
    const { events, scope } = traced();
    const llm = new RecordingLlm(twoPageReplies());
    const run = discover("Finish the wizard", { driver: new Pages(), llm, baseUrl: START, trace: scope, pageGuidance: ({ signal }) => {
      signals.push(signal);
      if (calls++) return "fresh";
      return new Promise(resolve => setTimeout(() => resolve("LATE"), PAGE_GUIDANCE_TIMEOUT_MS * 2));
    } });
    await vi.advanceTimersByTimeAsync(PAGE_GUIDANCE_TIMEOUT_MS * 4);
    await run;
    expect(signals[0]!.aborted).toBe(true);
    expect(llm.calls.some(c => c.prompt.includes("LATE"))).toBe(false);
    expect(llm.calls[1]!.prompt).toContain(section("fresh"));
    expect(gates(events)).toEqual(["page guidance unavailable: provider timed out"]);
  });

  it("continues without guidance when the provider fails, without echoing its error", async () => {
    const { events, scope } = traced();
    const llm = new RecordingLlm(twoPageReplies());
    const frozen = await discover("Finish the wizard", { driver: new Pages(), llm, baseUrl: START, trace: scope,
      pageGuidance: () => { throw new Error("boom private-detail"); } });
    expect(frozen.steps).toHaveLength(3);
    expect(llm.calls[0]!.system).not.toContain("Host page guidance");
    expect(gates(events)).toEqual(Array(3).fill("page guidance unavailable: provider failed"));
    expect(JSON.stringify(events)).not.toContain("private-detail");
  });

  it("propagates caller cancellation while the provider is pending, before any model call", async () => {
    const controller = new AbortController();
    const reason = new Error("host stop");
    let seen: AbortSignal | undefined;
    const llm = new RecordingLlm(twoPageReplies());
    await expect(discover("Go", { driver: new Pages(), llm, baseUrl: START, signal: controller.signal, pageGuidance: ({ signal }) => {
      seen = signal;
      queueMicrotask(() => controller.abort(reason));
      return new Promise(() => {});
    } })).rejects.toBe(reason);
    expect(seen!.aborted).toBe(true);
    expect(llm.calls).toHaveLength(0);
  });

  it("counts provider time against the run deadline instead of resetting it", async () => {
    const llm = new RecordingLlm(twoPageReplies());
    let seen: AbortSignal | undefined;
    const error = await discover("Go", { driver: new Pages(), llm, baseUrl: START, budget: { timeoutMs: 40 },
      pageGuidance: ({ signal }) => { seen = signal; return new Promise(resolve => setTimeout(() => resolve("slow"), 200)); },
    }).catch(e => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error.budget).toMatchObject({ limit: "time", modelCalls: 0 });
    expect(seen!.aborted).toBe(true);
    expect(llm.calls).toHaveLength(0);
  });

  it("rejects oversized output whole instead of truncating it", async () => {
    for (const [text, accepted] of [["x".repeat(MAX_PAGE_GUIDANCE_BYTES), true], ["x".repeat(MAX_PAGE_GUIDANCE_BYTES + 1), false],
      ["é".repeat(MAX_PAGE_GUIDANCE_BYTES / 2 + 1), false]] as const) {
      const { events, scope } = traced();
      const llm = new RecordingLlm(['{"action":"done"}', "[]"]);
      await discover("Go", { driver: new Pages(), llm, baseUrl: START, trace: scope, pageGuidance: () => text });
      expect(llm.calls[0]!.prompt.includes(section(text))).toBe(accepted);
      expect(gates(events)).toEqual(accepted ? [] : [`page guidance rejected: output exceeds ${MAX_PAGE_GUIDANCE_BYTES} UTF-8 bytes`]);
    }
  });

  it("keeps configured secrets, values and raw guidance out of the provider view and the trace", async () => {
    const secret = "s3cret-value";
    const driver = new Pages();
    driver.url = `${START}?k=${secret}`;
    driver.pages[driver.url] = [{ role: "textbox", name: `Account ${secret}`, value: "typed text" }];
    const requests: PageGuidanceRequest[] = [];
    const { events, scope } = traced();
    const llm = new RecordingLlm(['{"action":"done"}', "[]"]);
    await discover("Go", { driver, llm, trace: scope, secrets: { token: secret },
      pageGuidance: (r) => { requests.push(r); return `Use ${secret} here`; } });
    expect(requests[0]!.url).toBe(`${START}?k={token}`);
    expect(requests[0]!.elements).toEqual([{ role: "textbox", name: "Account {token}" }]);
    expect(llm.calls[0]!.prompt).toContain(section("Use {token} here"));
    expect(JSON.stringify(events)).not.toContain("here");
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("keeps static app context and dynamic guidance separate", async () => {
    const appContext = "Orders ship after payment.";
    const { events, scope } = traced();
    const llm = new RecordingLlm(['{"action":"done","assertions":[{"kind":"no-console-errors"}]}', "[]"]);
    const guided = await discover("Go", { driver: new Pages(), llm, baseUrl: START, appContext, trace: scope, pageGuidance: () => "Start page" });
    const plain = await discover("Go", { driver: new Pages(), llm: new RecordingLlm(['{"action":"done"}', "[]"]), baseUrl: START, appContext });

    expect(llm.calls[0]!.prompt).toContain(section(appContext));
    expect(llm.calls[0]!.prompt).toContain(section("Start page"));
    expect(llm.calls[1]!.prompt).toContain(section(appContext));
    expect(llm.calls[1]!.prompt).not.toContain("Start page");
    expect(guided.provenance).toEqual(plain.provenance);
    expect(guided.contract).toEqual(plain.contract);
    expect(guided).toEqual(plain);
    expect(gates(events)).toEqual(["page guidance: assertions proposed in a guided decision were not used"]);
  });

  it("does not let a guided done author the frozen checks", async () => {
    class Ordering extends StubDriver {
      posted = false;
      override async click(t: Target) { this.posted = true; await super.click(t); }
      override async observe(): Promise<Evidence> {
        const e = await super.observe();
        return { ...e, logic: { requests: this.posted ? [{ method: "POST", url: "https://app/api/order", status: 200 }] : [], console: [] } };
      }
    }
    const freeze = async (pageGuidance?: PageGuidanceProvider) => {
      const driver = new Ordering(START);
      driver.els = [{ role: "button", name: "Order" }];
      return discover("Order", { driver, baseUrl: START, pageGuidance, llm: new RecordingLlm(['{"action":"click","text":"Order"}',
        '{"action":"done","assertions":[{"kind":"request-status","urlIncludes":"/api/order","status":200}]}', "[]"]) });
    };
    const proves = (s: Scenario) => s.assertions.some(a => a.kind === "request-status");
    expect(proves(await freeze())).toBe(true);
    expect(proves(await freeze(() => "Order is the only control"))).toBe(false);
  });

  it("guides exploration decisions with the explore purpose", async () => {
    const requests: PageGuidanceRequest[] = [];
    const llm = new RecordingLlm(['{"action":"done"}']);
    await explore("Survey", { driver: new Pages(), llm, baseUrl: START, pageGuidance: (r) => { requests.push(r); return "Explore here"; } });
    expect(requests.map(r => [r.purpose, r.url])).toEqual([["explore", START]]);
    expect(llm.calls[0]!.prompt).toContain(section("Explore here"));
    expect(llm.calls[0]!.system).toContain("Host page guidance");
  });
});
