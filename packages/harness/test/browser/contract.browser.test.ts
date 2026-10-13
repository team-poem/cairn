import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { build } from "esbuild";
import { identifyScenario, compareContracts, runScenario } from "../../src/index.js";
import { StubDriver } from "../support/doubles.js";
import type { Target } from "../../src/core/types.js";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch()); });
afterAll(async () => { await browser?.close(); });

test("an engine embedded in a non-secure HTTP page replays without WebCrypto or a trace sink", async () => {
  const page = await browser.newPage();
  try {
    await page.route("http://contract.test/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>HTTP embedder</title>" }));
    await page.goto("http://contract.test/");
    expect(await page.evaluate(() => ({ secure: (globalThis as unknown as { isSecureContext: boolean }).isSecureContext, subtle: typeof crypto.subtle })))
      .toEqual({ secure: false, subtle: "undefined" });
    const bundle = await build({ entryPoints: ["src/browser.ts"], bundle: true, write: false,
      platform: "browser", format: "iife", globalName: "Cairn" });
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    const frozen = await identifyScenario({ name: "HTTP page", steps: [{ kind: "goto", url: "http://contract.test/cart" }],
      assertions: [{ kind: "navigated", to: "contract.test/cart" }] }, { intent: "Open the cart" });
    const results = await page.evaluate(async recorded => {
      const api = (globalThis as unknown as { Cairn: typeof import("../../src/browser.js") }).Cairn;
      const window = globalThis as unknown as { history: { pushState(data: unknown, unused: string, url: string): void }; location: { href: string } };
      const { contract: _contract, ...legacy } = recorded;
      const results = [];
      for (const scenario of [legacy, recorded]) {
        const driver = new api.FakeDriver({ evidence: {
          execution: { actions: [], navigated: true, blocked: false, finalUrl: "http://contract.test/cart" },
          perception: {}, logic: { requests: [], console: [] },
        } });
        const goto = driver.goto.bind(driver);
        driver.goto = async url => { await goto(url); window.history.pushState({}, "", url); };
        const result = await api.runHarness({ context: new api.InlineContextProvider(), planner: new api.StaticPlanner(scenario),
          driver, critic: new api.AssertionCritic(), reporter: { emit: async () => {} },
        }, "Open the cart");
        results.push({ passed: result.verdict.passed, actions: driver.visited.length, url: window.location.href,
          comparison: api.compareContracts(recorded.contract, result.verdict.contract), complete: result.verdict.contract?.complete });
      }
      return results;
    }, frozen);
    expect(results).toEqual(Array(2).fill({ passed: true, actions: 1, url: "http://contract.test/cart", comparison: "unknown", complete: false }));
  } finally { await page.close(); }
});

test("browser WebCrypto agrees with Node and a real DOM flow replays without models", async () => {
  const page = await browser.newPage();
  try {
    await page.route("https://contract.test/**", route => route.fulfill({ contentType: "text/html", body:
      '<!doctype html><button onclick="history.pushState({},\'\',\'/cart\')">Cart</button>' }));
    const scenario = await identifyScenario({ name: "Cart", steps: [
      { kind: "goto" as const, url: "https://contract.test/" },
      { kind: "click" as const, target: { role: "button", text: "Cart" } },
    ], assertions: [{ kind: "navigated" as const, to: "contract.test/cart" }] }, { intent: "Open the cart" });

    class PageDriver extends StubDriver {
      constructor(private readonly page: Page) { super(); }
      override async goto(url: string) { await this.page.goto(url); this.url = this.page.url(); }
      override async click(target: Target) { await this.page.getByRole("button", { name: target.text, exact: true }).click(); this.url = this.page.url(); }
    }
    const run = await runScenario(scenario, { driver: new PageDriver(page), reporter: { emit: async () => {} },
      llm: { id: "forbidden", complete: async () => { throw new Error("Model access forbidden"); } } });
    expect(page.url()).toBe("https://contract.test/cart");
    expect(run.result.verdict.passed).toBe(true);
    expect(run.result.usage?.llmCalls).toBe(0);
    expect(compareContracts(scenario.contract, run.result.verdict.contract)).toBe("same");

    const bundle = await build({ entryPoints: ["src/browser.ts"], bundle: true, write: false,
      platform: "browser", format: "iife", globalName: "Cairn" });
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    const browserContract = await page.evaluate(async data => {
      const api = (globalThis as unknown as { Cairn: typeof import("../../src/browser.js") }).Cairn;
      return api.scenarioContract(data);
    }, scenario);
    expect(browserContract).toEqual(scenario.contract);
    const changed = await identifyScenario({ ...scenario, assertions: [
      ...scenario.assertions, { kind: "request-status", urlIncludes: "/never-requested", status: 200 },
    ] });
    const second = await runScenario(changed, { driver: new PageDriver(page), reporter: { emit: async () => {} } });
    expect(second.result.verdict.passed).toBe(false);
    expect(compareContracts(run.result.verdict.contract, second.result.verdict.contract)).toBe("changed");
  } finally { await page.close(); }
});
