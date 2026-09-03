import { describe, expect, it } from "vitest";
import { explore } from "../../../src/core/explore/index.js";
import type { ActionPolicy } from "../../../src/core/discover/decision.js";
import { ScriptedLlm, StubDriver } from "../../support/doubles.js";
import type { ConsoleMessage, Evidence, NetworkRequest, Target } from "../../../src/core/types.js";

/** A StubDriver whose observation grows as the test scripts it — clicks can navigate (navOn),
 * fire requests (requestOn), or log console errors (consoleOn). */
class ExploreDriver extends StubDriver {
  readonly requests: NetworkRequest[] = [];
  readonly consoleMsgs: ConsoleMessage[] = [];
  readonly requestOn: Record<string, NetworkRequest> = {};
  readonly consoleOn: Record<string, ConsoleMessage> = {};

  override async click(t: Target): Promise<void> {
    await super.click(t);
    const fired = this.requestOn[t.text ?? ""];
    if (fired) this.requests.push(fired);
    const logged = this.consoleOn[t.text ?? ""];
    if (logged) this.consoleMsgs.push(logged);
  }

  override async observe(): Promise<Evidence> {
    return {
      execution: { actions: [], navigated: true, finalUrl: this.url, blocked: false },
      perception: {},
      logic: { requests: [...this.requests], console: [...this.consoleMsgs] },
    };
  }
}

const START = "https://shop/";

describe("explore", () => {
  it("wanders under a charter and reports agent notes — no freeze artifacts", async () => {
    const driver = new ExploreDriver(START);
    driver.els = [{ role: "link", name: "Products" }];
    driver.navOn["Products"] = "https://shop/products";
    const llm = new ScriptedLlm([
      '{"action":"note","severity":"warn","text":"landing page has no visible search","reason":"survey"}',
      '{"action":"click","text":"Products","reason":"visit catalog"}',
      '{"action":"done","reason":"covered"}',
    ]);

    const report = await explore("survey the shop", { driver, llm, baseUrl: START });

    // StubDriver's locate is identity (no role/index enrichment — that's FakeDriver's job)
    expect(report.steps).toEqual([
      { kind: "goto", url: START },
      { kind: "click", target: { text: "Products" }, intent: "visit catalog" },
    ]);
    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: "agent-note",
        severity: "warn",
        detail: "landing page has no visible search",
      }),
    ]);
    expect(report.visited).toEqual(["shop", "shop/products"]);
    expect(report.truncated).toBe(false);
    expect(report.usage.llmCalls).toBe(3);
    // freeze-less by construction: an ExploreReport is not a Scenario
    expect(report).not.toHaveProperty("assertions");
    expect(report.steps.every((s) => s.expect === undefined)).toBe(true);
  });

  it("derives a failed-request finding from the action's own request tail", async () => {
    const driver = new ExploreDriver(START);
    driver.els = [{ role: "button", name: "Buy" }];
    driver.navOn["Buy"] = "https://shop/checkout";
    driver.requestOn["Buy"] = { method: "POST", url: "https://shop/api/pay", status: 500 };
    const llm = new ScriptedLlm(['{"action":"click","text":"Buy"}', '{"action":"done"}']);

    const report = await explore("try to buy", { driver, llm, baseUrl: START });

    expect(report.findings).toEqual([
      expect.objectContaining({ kind: "failed-request", severity: "error", stepIndex: 1 }),
    ]);
    expect(report.findings[0]!.detail).toContain("POST https://shop/api/pay → 500");
  });

  it("derives a console-error finding, honoring benignConsole", async () => {
    const driver = new ExploreDriver(START);
    driver.els = [{ role: "button", name: "Open" }];
    driver.navOn["Open"] = "https://shop/open";
    driver.consoleOn["Open"] = { type: "error", text: "TypeError: cart is null" };
    const llm = new ScriptedLlm(['{"action":"click","text":"Open"}', '{"action":"done"}']);

    const report = await explore("survey", { driver, llm, baseUrl: START });
    expect(report.findings).toEqual([expect.objectContaining({ kind: "console-error" })]);

    const silenced = await explore("survey", {
      driver: (() => {
        const d = new ExploreDriver(START);
        d.els = [{ role: "button", name: "Open" }];
        d.navOn["Open"] = "https://shop/open";
        d.consoleOn["Open"] = { type: "error", text: "TypeError: cart is null" };
        return d;
      })(),
      llm: new ScriptedLlm(['{"action":"click","text":"Open"}', '{"action":"done"}']),
      baseUrl: START,
      benignConsole: ["TypeError: cart"],
    });
    expect(silenced.findings).toEqual([]);
  });

  it("flags a dead click — same page, no request, no element change", async () => {
    const driver = new ExploreDriver(START);
    driver.els = [{ role: "button", name: "Apply" }]; // click navigates nowhere, fires nothing
    const llm = new ScriptedLlm(['{"action":"click","text":"Apply"}', '{"action":"done"}']);

    const report = await explore("survey", { driver, llm, baseUrl: START });

    expect(report.findings).toEqual([
      expect.objectContaining({ kind: "dead-action", severity: "warn", stepIndex: 1 }),
    ]);
  });

  it("records an action-error finding when the page won't take the action, and adapts", async () => {
    const driver = new ExploreDriver(START);
    driver.els = [{ role: "link", name: "Contact" }];
    driver.navOn["Contact"] = "https://shop/contact";
    const failing = driver.click.bind(driver);
    driver.click = async (t) => {
      if (t.text === "Ghost") throw new Error("element not found: Ghost");
      return failing(t);
    };
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Ghost"}',
      '{"action":"click","text":"Contact"}',
      '{"action":"done"}',
    ]);

    const report = await explore("survey", { driver, llm, baseUrl: START });

    expect(report.findings).toEqual([
      expect.objectContaining({ kind: "action-error", severity: "warn" }),
    ]);
    // the failure did not end the survey — the next decision still executed
    expect(report.steps).toHaveLength(2);
  });

  it("marks the report truncated at the step cap", async () => {
    const driver = new ExploreDriver(START);
    driver.els = [{ role: "button", name: "Next" }];
    const llm = new ScriptedLlm(Array(5).fill('{"action":"click","text":"Next"}'));

    const report = await explore("survey", { driver, llm, baseUrl: START, maxSteps: 3 });

    expect(report.truncated).toBe(true);
    expect(report.steps).toHaveLength(4); // seed goto + 3 capped actions
  });

  it("gives up after consecutive policy blocks (truncated), and a policy stop is a trusted finish", async () => {
    const denyAll: ActionPolicy = { vet: () => ({ ok: false, reason: "read-only survey" }) };
    const blocked = await explore("survey", {
      driver: new ExploreDriver(START),
      llm: new ScriptedLlm(Array(9).fill('{"action":"click","text":"Nope"}')),
      baseUrl: START,
      policy: denyAll,
    });
    expect(blocked.truncated).toBe(true);
    expect(blocked.steps).toEqual([{ kind: "goto", url: START }]);
    expect(blocked.usage.llmCalls).toBe(3); // MAX_CONSECUTIVE_BLOCKS, not the step cap

    const stopAtStart: ActionPolicy = { vet: () => ({ ok: true }), stop: (steps) => steps.length >= 1 };
    const stopped = await explore("survey", {
      driver: new ExploreDriver(START),
      llm: new ScriptedLlm(['{"action":"click","text":"Never"}']),
      baseUrl: START,
      policy: stopAtStart,
    });
    expect(stopped.truncated).toBe(false);
    expect(stopped.usage.llmCalls).toBe(0); // stop fired before any completion
  });

  it("normalizes an unknown note severity to info — model output is data, not a contract", async () => {
    const driver = new ExploreDriver(START);
    const llm = new ScriptedLlm([
      '{"action":"note","severity":"critical","text":"checkout is unreachable"}',
      '{"action":"done"}',
    ]);
    const report = await explore("survey", { driver, llm, baseUrl: START });
    // an invented level must not slip past the renderer's severity groups or the CLI's error gate
    expect(report.findings).toEqual([
      expect.objectContaining({ kind: "agent-note", severity: "info" }),
    ]);
  });

  it("nudges the model when a note carries no text, instead of recording an empty finding", async () => {
    const driver = new ExploreDriver(START);
    const llm = new ScriptedLlm(['{"action":"note","severity":"warn"}', '{"action":"done"}']);
    const report = await explore("survey", { driver, llm, baseUrl: START });
    expect(report.findings).toEqual([]);
  });

  it("dedupes repeated findings in the final report", async () => {
    const driver = new ExploreDriver(START);
    driver.els = [{ role: "button", name: "Apply" }];
    const llm = new ScriptedLlm([
      '{"action":"click","text":"Apply"}',
      '{"action":"click","text":"Apply"}',
      '{"action":"done"}',
    ]);

    const report = await explore("survey", { driver, llm, baseUrl: START });

    expect(report.findings).toEqual([
      expect.objectContaining({ kind: "dead-action", occurrences: 2 }),
    ]);
  });

  it("streams findings and steps to the host callbacks", async () => {
    const driver = new ExploreDriver(START);
    driver.els = [{ role: "link", name: "About" }];
    driver.navOn["About"] = "https://shop/about";
    const llm = new ScriptedLlm([
      '{"action":"note","text":"cluttered header"}',
      '{"action":"click","text":"About"}',
      '{"action":"done"}',
    ]);
    const seen: string[] = [];
    await explore("survey", {
      driver,
      llm,
      baseUrl: START,
      onStep: (d, step) => seen.push(`step:${d.action}${step ? ":ran" : ""}`),
      onFinding: (f) => seen.push(`finding:${f.kind}`),
    });
    expect(seen).toEqual(["finding:agent-note", "step:note", "step:click:ran", "step:done"]);
  });
});

describe("a policy that throws is the harness's problem, not the app's", () => {
  it("exploreThrowingVetIsNotAFinding: a vet exception is a recorded rejection but never an action-error finding", async () => {
    const driver = new StubDriver(START);
    driver.els = [{ role: "button", name: "Delete" }];
    const policy: ActionPolicy = {
      vet: () => {
        throw new Error("policy exploded");
      },
    };
    const llm = new ScriptedLlm(['{"action":"click","text":"Delete"}', '{"action":"done"}']);
    const report = await explore("survey", { driver, llm, baseUrl: START, policy });
    expect(driver.clicked).toEqual([]);
    // The page never refused anything. The gate did. Reporting it as a UX finding blames the app.
    expect(report.findings).toEqual([]);
  });
});
