import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { build } from "esbuild";
import { identifyScenario, compareContracts, runScenario } from "../../src/index.js";
import { StubDriver } from "../support/doubles.js";
import type { Target } from "../../src/core/types.js";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch()); });
afterAll(async () => { await browser?.close(); });

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
