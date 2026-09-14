// file: packages/harness/test/browser/observation-documents.browser.test.ts
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser, type Frame, type Page } from "playwright";
import { ChromeDevToolsDriver, parseSnapshotRows } from "../../src/adapters/drivers/chrome.js";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch()); });
afterAll(async () => { await browser?.close(); });

type DocumentFixture = {
  page: Page;
  driver: ChromeDevToolsDriver;
  clicks: string[];
  frame: (path: string) => Frame;
  onSnapshot: (callback: (verbose: boolean) => Promise<void>) => void;
  evaluations: Array<{ document: string; ids: string[] }>;
};
async function withDocuments(run: (fixture: DocumentFixture) => Promise<void>) {
  const page = await browser.newPage();
  const pages: Record<string, string> = {
    "/": '<title>Main</title><span data-row="StaticText" id="clock">12:00</span><button id="main" data-row="button">Save</button><iframe id="same" title="Same" src="http://main.test/same"></iframe><iframe id="cross" title="Cross" src="http://cross.test/cross"></iframe><iframe id="empty" src="http://main.test/empty"></iframe>',
    "/same": '<title>Same</title><button id="unnamed" data-row="button" aria-label=""></button><button id="same" data-row="button">Save</button>',
    "/cross": '<title>Cross</title><button id="cross" data-row="button">Save</button><iframe id="nested" title="Nested" src="http://nested.test/nested"></iframe>',
    "/nested": '<title>Nested</title><button id="nested" data-row="button">Save</button>',
    "/empty": '<body><span id="clock">12:00</span></body>',
  };
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: pages[new URL(route.request().url()).pathname] ?? pages["/empty"]! }));
  await page.goto("http://main.test/");
  const driver = new ChromeDevToolsDriver({ promoteClickables: false });
  const clicks: string[] = [];
  const evaluations: DocumentFixture["evaluations"] = [];
  let uidFrames = new Map<string, Frame>();
  let snapshotHook: ((verbose: boolean) => Promise<void>) | undefined;
  const capture = async (verbose: boolean) => {
    await snapshotHook?.(verbose);
    const nextFrames = new Map<string, Frame>();
    const visit = async (frame: Frame, depth: number): Promise<string[]> => {
      const lines = await frame.evaluate<Array<{ uid: string; line: string; owner?: string }>>(`(() => {
        const state = globalThis.fixture ??= { prefix: Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-'), next: 0, nodes: new Map(), ids: new WeakMap() };
        const uid = node => {
          let value = state.ids.get(node);
          if (!value) { value = state.prefix + ':' + state.next++; state.ids.set(node, value); state.nodes.set(value, node); }
          return value;
        };
        const out = [];
        const rootUid = uid(document);
        out.push({ uid: rootUid, line: 'uid=' + rootUid + ' RootWebArea' + (document.title ? ' ' + JSON.stringify(document.title) : '') + ' url=' + JSON.stringify(location.href) });
        for (const node of document.querySelectorAll('[data-row], iframe')) {
          if (!${verbose} && node.hasAttribute('data-verbose')) continue;
          const id = uid(node);
          if (node.tagName === 'IFRAME') out.push({ uid: id, line: '  uid=' + id + ' Iframe' + (node.getAttribute('title') ? ' ' + JSON.stringify(node.getAttribute('title')) : ''), owner: node.id });
          else out.push({ uid: id, line: '  uid=' + id + ' ' + (node.getAttribute('role') ?? node.getAttribute('data-row')) + ' ' + JSON.stringify(node.getAttribute('aria-label') ?? node.textContent ?? '') });
        }
        return out;
      })()`);
      const out: string[] = [];
      for (const line of lines) {
        nextFrames.set(line.uid, frame);
        out.push(" ".repeat(depth) + line.line);
        if (line.owner !== undefined) {
          for (const child of frame.childFrames()) {
            const owner = await child.frameElement();
            if (await owner.getAttribute("id") === line.owner) out.push(...await visit(child, depth + 4));
            await owner.dispose();
          }
        }
      }
      return out;
    };
    const raw = (await visit(page.mainFrame(), 0)).join("\n");
    uidFrames = nextFrames;
    return raw;
  };
  (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
    if (name === "list_pages") return `0: ${page.url()} [selected]`;
    if (name === "take_snapshot") return capture(args.verbose === true);
    if (name === "evaluate_script") {
      const ids = (args.args ?? []) as string[];
      const frames = ids.map(id => {
        const frame = uidFrames.get(id);
        if (!frame) throw new Error(`Element uid "${id}" not found on page 0.`);
        return frame;
      });
      if (new Set(frames).size > 1) throw new Error("Elements from different frames cannot be evaluated together.");
      const frame = frames[0] ?? page.mainFrame();
      evaluations.push({ document: frame.url(), ids });
      return JSON.stringify(await frame.evaluate(`(${String(args.function)})(...${JSON.stringify(ids)}.map(uid => globalThis.fixture.nodes.get(uid)))`));
    }
    if (name === "click") {
      const id = String(args.uid);
      const frame = uidFrames.get(id);
      if (!frame) throw new Error("Element no longer exists");
      clicks.push(await frame.evaluate(`(() => { const node = globalThis.fixture.nodes.get(${JSON.stringify(id)}); if (!node?.isConnected) throw new Error('detached'); node.click(); return location.pathname + '#' + node.id; })()`));
      return "";
    }
    throw new Error(`Unexpected MCP action: ${name}`);
  };
  try {
    await run({ page, driver, clicks, frame: path => page.frames().find(frame => new URL(frame.url()).pathname === path)!, onSnapshot: callback => { snapshotHook = callback; }, evaluations });
  } finally { await page.close(); }
}

test("documentRefsAcrossFrames: same-origin, cross-origin and nested duplicates freeze with global ordinals and replay deterministically", async () => {
  await withDocuments(async ({ driver, clicks }) => {
    for (const [position, expected] of ["/#main", "/same#same", "/cross#cross", "/nested#nested"].entries()) {
      const rows = await driver.snapshot({ perception: true });
      const buttons = rows.filter(row => row.role === "button" && row.name === "Save");
      expect(buttons).toHaveLength(4);
      expect(buttons.every(row => typeof row.ref === "string")).toBe(true);
      const ref = buttons[position]!.ref!;
      const target = JSON.parse(JSON.stringify(await driver.locateRef(ref)));
      expect(target).toEqual({ text: "Save", role: "button", index: position === 0 ? 0 : position + 1, nth: position });
      expect(JSON.stringify(target)).not.toContain(ref);
      await driver.click(target, ref);
      await driver.click(target);
      expect(clicks.slice(-2)).toEqual([expected, expected]);
    }
  });
});
