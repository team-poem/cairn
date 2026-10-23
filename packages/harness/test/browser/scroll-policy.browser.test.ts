import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser } from "playwright";
import { ChromeDevToolsDriver } from "../../src/adapters/drivers/chrome.js";
import { createHostOwnedRootScope } from "../../src/adapters/drivers/host-owned-roots.js";
import { createScrollNoProgressPolicy } from "../../src/core/scroll-policy.js";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch()); });
afterAll(async () => { await browser?.close(); });

async function fixture(run: (ctx: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const ctx = await setup();
  try { await run(ctx); } finally { await ctx.page.close(); }
}
async function setup() {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent('<!doctype html><title>Scroll</title><style>body{margin:0}main{height:2400px}aside{position:fixed;right:0;top:0}</style><main><button>App action</button></main><aside id="host">Host panel</aside>');
  const scope = createHostOwnedRootScope();
  const driver = new ChromeDevToolsDriver({ hostOwnedRoots: scope });
  (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
    if (name === "evaluate_script") return JSON.stringify(await page.evaluate(`(${args.function})(...${JSON.stringify(args.args ?? [])}.map(id => globalThis.nodes[id]))`));
    if (name === "take_snapshot") return page.evaluate(`(() => {
      globalThis.nodes = { '0': document, '1': globalThis.closedTarget || document.querySelector('button,h1') };
      return 'uid=0 RootWebArea "Scroll"\\nuid=1 button "App action"';
    })()`);
    if (name === "list_network_requests") return "";
    throw new Error(`Unexpected ${name}`);
  };
  return { page, driver, scope };
}

test("measures the actual window scroll, with stable document identity and new navigation identity", async () => {
  await fixture(async ({ page, driver }) => {
    const before = await driver.scrollState();
    expect(before).toMatchObject({ x: 0, y: 0, width: 800, height: 600, scrollHeight: 2400 });
    await driver.scroll("down");
    const after = await driver.scrollState();
    expect(after?.y).toBe(540); expect(after?.region).toBe(before?.region);
    await page.goto('data:text/html,<!doctype html><title>New document</title><h1>New</h1>');
    expect((await driver.scrollState())?.region).not.toBe(before?.region);
  });
});

test.each(["nested", "body-scroll", "frame", "shadow", "closed-shadow", "transform", "translate", "rotate", "scale", "oversized"])("abstains with %s coverage", async kind => {
  await fixture(async ({ page, driver }) => {
    await page.evaluate(`(() => { const kind = ${JSON.stringify(kind)};
      const el = document.createElement("div"); document.querySelector("main").append(el);
      if (kind === "nested") { el.style.cssText = "height:20px;overflow:auto"; el.innerHTML = '<div style="height:200px">Nested content</div>'; }
      if (kind === "frame") el.append(document.createElement("iframe"));
      if (kind === "shadow") el.attachShadow({ mode: "open" }).innerHTML = "<button>Shadow action</button>";
      if (kind === "closed-shadow") {
        const root = el.attachShadow({ mode: 'closed' });
        root.innerHTML = '<div style="height:100px;overflow:auto"><div style="height:2000px"><button>Closed target</button></div></div>';
        globalThis.closedTarget = root.querySelector('button');
      }
      if (kind === "body-scroll") { document.documentElement.style.overflow = 'hidden'; document.body.style.cssText = 'height:100vh;overflow:auto;margin:0'; }
      if (kind === "transform") el.style.transform = "scale(2)";
      if (kind === "translate") el.style.translate = '0px 100px';
      if (kind === "rotate") el.style.rotate = '20deg';
      if (kind === "scale") el.style.scale = '2';
      if (kind === "oversized") el.innerHTML = "<span>Item</span>".repeat(4100);
    })()`);
    expect(await driver.scrollState()).toBeUndefined();
  });
});

test("fixed host churn does not change app geometry; ownership or in-flow host layout invalidates coverage", async () => {
  await fixture(async ({ page, driver, scope }) => {
    await page.evaluate(`(${scope.registerScript})(document.getElementById('host'))`);
    const before = await driver.scrollState(); expect(before).toBeDefined();
    const policy = createScrollNoProgressPolicy({ tolerance: 2 }).createRun!();
    const ctx = { elements: [{ role: "button", name: "App action" }], url: "https://app", scroll: before };
    policy.observe!(ctx);
    for (let i = 0; i < 2; i++) {
      await page.locator("#host").evaluate((el, i) => { el.textContent = `Host cycle ${i}`; }, i);
      const measured = await driver.scrollState(); expect(measured).toEqual(before);
      policy.executed!({ kind: "scroll" }, ctx); policy.observe!({ ...ctx, scroll: measured });
    }
    expect(policy.incomplete!()?.diagnostic.code).toBe("no-progress");
    await page.evaluate("document.getElementById('host').style.position = 'static'");
    expect(await driver.scrollState()).toBeUndefined();
    await page.evaluate(`(${scope.unregisterScript})(document.getElementById('host'))`);
    expect((await driver.scrollState())?.region).not.toBe(before?.region);
  });
});

test("does not turn transport failure into unsupported coverage", async () => {
  const driver = new ChromeDevToolsDriver();
  (driver as unknown as { call: unknown }).call = async () => { throw Object.assign(new Error("offline"), { kind: "transport" }); };
  await expect(driver.scrollState()).rejects.toThrow("offline");
});
