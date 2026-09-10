// file: packages/harness/test/browser/observation-continuity.browser.test.ts
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { ChromeDevToolsDriver } from "../../src/adapters/drivers/chrome.js";
import type { Target } from "../../src/core/types.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
});
afterAll(async () => { await browser?.close(); });

async function withContinuityPage(run: (fixture: {
  page: Page;
  driver: ChromeDevToolsDriver;
  clicks: string[];
  onCompact: (callback: () => Promise<void>) => void;
}) => Promise<void>) {
  const page = await browser.newPage();
  try {
    await page.setContent('<span id="clock" data-row="StaticText">12:00</span><div id="spinner" class="loading"></div><img id="lazy" alt="Preview"><button id="first" data-row="button">Save</button><button id="second" data-row="button">Save</button>');
    await page.evaluate(`(() => {
      globalThis.cairnFixtureNodes = new Map();
      globalThis.cairnFixtureUids = new WeakMap();
      globalThis.cairnFixtureNextUid = 0;
    })()`);
    const driver = new ChromeDevToolsDriver({ promoteClickables: false });
    const clicks: string[] = [];
    let beforeCompact: (() => Promise<void>) | undefined;
    (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
      if (name === "take_snapshot") {
        if (!args.verbose) await beforeCompact?.();
        // This fixture reports live DOM semantics for its explicit simple roles. It never
        // hardcodes a guard result; production evaluate_script code runs in real Chrome.
        return page.evaluate(`(() => {
          return [...document.querySelectorAll('[data-row]')].map(el => {
            let uid = globalThis.cairnFixtureUids.get(el);
            if (!uid) {
              uid = 'node_' + ++globalThis.cairnFixtureNextUid;
              globalThis.cairnFixtureUids.set(el, uid);
              globalThis.cairnFixtureNodes.set(uid, el);
            }
            const role = el.getAttribute('role') || el.getAttribute('data-row');
            const name = el.getAttribute('aria-label') || el.textContent;
            return 'uid=' + uid + ' ' + role + ' ' + JSON.stringify(name);
          }).join('\\n');
        })()`);
      }
      if (name === "list_pages") return '0: https://example.test/form [selected]';
      if (name === "evaluate_script") {
        return JSON.stringify(await page.evaluate(`(${String(args.function)})(...${JSON.stringify(args.args ?? [])}.map(uid => globalThis.cairnFixtureNodes.get(uid)))`));
      }
      if (name === "click") {
        const clicked = await page.evaluate<string>(`(() => {
          const el = globalThis.cairnFixtureNodes.get(${JSON.stringify(args.uid)});
          if (!el?.isConnected) throw new Error('captured node is detached');
          el.click();
          return el.id;
        })()`);
        clicks.push(clicked);
        return "";
      }
      throw new Error(`unexpected MCP action: ${name}`);
    };
    await run({ page, driver, clicks, onCompact: callback => { beforeCompact = callback; } });
  } finally { await page.close(); }
}

async function secondSaveRef(driver: ChromeDevToolsDriver): Promise<string> {
  const rows = await driver.snapshot({ perception: true });
  const ref = rows.filter(row => row.role === "button" && row.name === "Save")[1]?.ref;
  expect(ref).toBeTypeOf("string");
  return ref!;
}

test("observationUnrelatedChangesBeforeEnrichment: clock text, spinner attributes and lazy image changes preserve the selected duplicate", async () => {
  for (const mutation of [
    "document.querySelector('#clock').firstChild.data = '12:01'",
    "document.querySelector('#spinner').className = 'loading phase-two'",
    "document.querySelector('#lazy').setAttribute('src', 'data:image/gif;base64,R0lGODlhAQABAAAAACw=')",
  ]) {
    await withContinuityPage(async ({ page, driver, clicks }) => {
      const ref = await secondSaveRef(driver);
      await page.evaluate(mutation);
      const target = await driver.locateRef(ref);
      expect(target).toEqual({ text: "Save", role: "button", index: 1, nth: 1 });
      await driver.click(target, ref);
      expect(clicks).toEqual(["second"]);
    });
  }
});

test("observationClockChangesDuringCompactCapture: repeated incidental updates do not prevent exact addressing or durable replay", async () => {
  await withContinuityPage(async ({ page, driver, clicks, onCompact }) => {
    let ticks = 0;
    onCompact(async () => {
      ticks++;
      await page.evaluate(`document.querySelector('#clock').firstChild.data = ${JSON.stringify("tick:")} + ${ticks}`);
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const ref = await secondSaveRef(driver);
      const frozen = JSON.parse(JSON.stringify(await driver.locateRef(ref))) as Target;
      expect(frozen).toEqual({ text: "Save", role: "button", index: 1, nth: 1 });
      expect(JSON.stringify(frozen)).not.toContain(ref);
      await driver.click(frozen, ref);
      await driver.click(frozen);
    }
    expect(ticks).toBeGreaterThanOrEqual(3);
    expect(clicks).toEqual(Array(6).fill("second"));
  });
});

test("observationUnrelatedStructuralChanges: inserting or replacing decorative siblings preserves exact identity and role ordinals", async () => {
  for (const mutation of [
    "document.querySelector('#spinner').appendChild(document.createElement('span'))",
    "document.querySelector('#lazy').replaceWith(document.querySelector('#lazy').cloneNode(true))",
  ]) {
    await withContinuityPage(async ({ page, driver, clicks }) => {
      const ref = await secondSaveRef(driver);
      await page.evaluate(mutation);
      const target = await driver.locateRef(ref);
      expect(target).toEqual({ text: "Save", role: "button", index: 1, nth: 1 });
      await driver.click(target, ref);
      expect(clicks).toEqual(["second"]);
    });
  }
});
