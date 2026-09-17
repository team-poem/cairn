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
test("documentRefContinuity: frame navigation, owner changes and global cohort drift expire refs before enrichment and dispatch", async () => {
  const mutations = [
    async ({ frame }: DocumentFixture) => { await frame("/cross").goto("http://cross.test/cross?reload=1"); },
    async ({ frame }: DocumentFixture) => { await frame("/cross").evaluate("location.reload()"); await frame("/cross").waitForLoadState(); },
    async ({ page }: DocumentFixture) => { await page.locator("#cross").evaluate(node => node.remove()); },
    async ({ page }: DocumentFixture) => { await page.locator("#cross").evaluate(node => node.replaceWith(node.cloneNode(true))); },
    async ({ page }: DocumentFixture) => { await page.evaluate("document.querySelector('#same').before(document.querySelector('#cross'))"); },
    async ({ frame }: DocumentFixture) => { await frame("/empty").evaluate("document.body.innerHTML = '<button data-row=button>Save</button>'"); },
    async ({ frame }: DocumentFixture) => { await frame("/same").evaluate("document.querySelector('#unnamed').remove()"); },
    async ({ frame }: DocumentFixture) => { await frame("/same").evaluate("document.querySelector('#same').replaceWith(document.querySelector('#same').cloneNode(true))"); },
    async ({ frame }: DocumentFixture) => { await frame("/nested").evaluate("document.querySelector('button').setAttribute('aria-label', 'Cancel')"); },
    async ({ frame }: DocumentFixture) => { await frame("/nested").evaluate("document.querySelector('button').setAttribute('role', 'link')"); },
    async ({ page }: DocumentFixture) => { await page.evaluate("const f = document.createElement('iframe'); f.id='new'; f.src='http://main.test/empty'; document.body.append(f)"); },
  ];
  for (const dispatch of [false, true]) for (const mutate of mutations) {
    await withDocuments(async fixture => {
      const rows = await fixture.driver.snapshot({ perception: true });
      const ref = rows.find(row => row.name === "Save" && row.role === "button")?.ref;
      expect(ref).toBeTypeOf("string");
      const target = dispatch ? await fixture.driver.locateRef(ref!) : { text: "Save", role: "button", nth: 0 };
      await mutate(fixture);
      await expect(dispatch ? fixture.driver.click(target, ref) : fixture.driver.locateRef(ref!)).rejects.toThrow(/ref|expired|continuity/i);
      expect(fixture.clicks).toEqual([]);
    });
  }
}, 60_000);
test("documentRefStableIntervals: incidental changes pass, continuously mutating documents fail within two validation captures", async () => {
  await withDocuments(async ({ driver, frame, clicks, onSnapshot }) => {
    const rows = await driver.snapshot({ perception: true });
    const ref = rows.find(row => row.name === "Save" && row.role === "button")?.ref;
    expect(ref).toBeTypeOf("string");
    await frame("/empty").evaluate("document.querySelector('#clock').textContent = '12:01'");
    const target = await driver.locateRef(ref!);
    await driver.click(target, ref);
    expect(clicks).toEqual(["/#main"]);
    const fresh = (await driver.snapshot({ perception: true })).find(row => row.name === "Save" && row.role === "button")!.ref!;
    let captures = 0;
    onSnapshot(async verbose => {
      if (verbose) { captures++; await frame("/empty").evaluate("document.querySelector('#clock').textContent += '.'"); }
    });
    await expect(driver.locateRef(fresh)).rejects.toThrow(/stable|expired|ref/i);
    expect(captures).toBeLessThanOrEqual(2);
    expect(clicks).toEqual(["/#main"]);
  });
});
test("documentRefUnknownGuard: unavailable document measurements preserve candidates without offering refs", async () => {
  await withDocuments(async ({ driver }) => {
    const rows = await driver.snapshot({ perception: true });
    expect(rows.some(row => row.ref !== undefined)).toBe(true);
    const call = (driver as unknown as { call: (name: string, args?: Record<string, unknown>) => Promise<string> }).call;
    (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
      if (name === "evaluate_script" && (args.args as string[] | undefined)?.length) throw new Error("Evaluation is unavailable");
      return call(name, args);
    };
    const unknown = await driver.snapshot({ perception: true });
    expect(unknown.filter(row => row.name === "Save" && row.role === "button")).toHaveLength(4);
    expect(unknown.every(row => row.ref === undefined)).toBe(true);
  });
});
test("documentRefAsyncSupersession: recapture during the final page check cannot dispatch the old exact ref", async () => {
  await withDocuments(async ({ driver, clicks }) => {
    const ref = (await driver.snapshot({ perception: true })).find(row => row.role === "button" && row.name === "Save")!.ref!;
    const target = await driver.locateRef(ref);
    const original = (driver as unknown as { call: (name: string, args?: Record<string, unknown>) => Promise<string> }).call;
    let pageChecks = 0;
    (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
      if (name === "list_pages" && ++pageChecks === 2) await driver.snapshot({ perception: true });
      return original(name, args);
    };
    await expect(driver.click(target, ref)).rejects.toThrow(/expired|ref|superseded/i);
    expect(clicks).toEqual([]);
  });
});
test("documentRefValidationWindow: mutations in a previously checked document cannot escape later frame validation", async () => {
  for (const empty of [false, true]) await withDocuments(async ({ driver, page, frame, clicks, evaluations }) => {
    if (empty) await page.evaluate("document.querySelector('#same').before(document.querySelector('#empty'))");
    const ref = (await driver.snapshot({ perception: true })).find(row => row.role === "button" && row.name === "Save")!.ref!;
    const target = await driver.locateRef(ref);
    const original = (driver as unknown as { call: (name: string, args?: Record<string, unknown>) => Promise<string> }).call;
    let changed = false;
    (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await original(name, args);
      if (!changed && name === "evaluate_script" && String(args.function).includes("const keys =") && evaluations.at(-1)?.document.endsWith("/nested")) {
        changed = true;
        if (empty) await frame("/empty").evaluate("document.body.innerHTML = '<button data-row=button>Save</button>'");
        else await page.evaluate("document.querySelector('#main').textContent = 'Delete'");
      }
      return result;
    };
    await expect(driver.click(target, ref)).rejects.toThrow(/ref|expired|cohort/i);
    expect(changed).toBe(true);
    expect(clicks).toEqual([]);
  });
});

test("documentCaptureSupersession: a recapture during facts cannot publish older refs or replace the newer observation", async () => {
  await withDocuments(async ({ driver }) => {
    const original = (driver as unknown as { call: (name: string, args?: Record<string, unknown>) => Promise<string> }).call;
    let freshRef: string | undefined;
    let superseded = false;
    (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await original(name, args);
      if (!superseded && name === "evaluate_script" && String(args.function).includes("const ids =") && String(args.function).includes("const active =")) {
        superseded = true;
        freshRef = (await driver.snapshot({ perception: true })).find(row => row.role === "button" && row.name === "Save")?.ref;
      }
      return result;
    };
    await expect(driver.snapshot({ perception: true })).rejects.toThrow(/expired|superseded|observation/i);
    expect(freshRef).toBeTypeOf("string");
    expect(await driver.locateRef(freshRef!)).toMatchObject({ text: "Save", nth: 0 });
  });
});
test("documentUidRotation: fresh root, owner and verbose-peer UIDs preserve original objects and the compact target", async () => {
  await withDocuments(async ({ driver, page, frame, onSnapshot, clicks }) => {
    await frame("/same").evaluate("document.querySelector('#unnamed').setAttribute('data-verbose', '')");
    const ref = (await driver.snapshot({ perception: true })).find(row => row.role === "button" && row.name === "Save")?.ref;
    expect(ref).toBeTypeOf("string");
    let rotated = false;
    onSnapshot(async verbose => {
      if (verbose || rotated) return;
      rotated = true;
      for (const context of page.frames()) await context.evaluate(`(() => {
        const state = globalThis.fixture;
        const selected = location.pathname === '/' ? document.querySelector('#main') : undefined;
        const uid = selected && state.ids.get(selected);
        state.ids = new WeakMap(); state.nodes = new Map();
        if (selected) { state.ids.set(selected, uid); state.nodes.set(uid, selected); }
      })()`);
    });
    const target = await driver.locateRef(ref!);
    expect(rotated).toBe(true);
    expect(target).toEqual({ text: "Save", role: "button", index: 0, nth: 0 });
    await driver.click(target, ref);
    expect(clicks).toEqual(["/#main"]);
  });
});
test("documentUidRebinding: a reused selected UID cannot silently switch to another same-named DOM object", async () => {
  await withDocuments(async ({ driver, page, clicks }) => {
    await page.evaluate("const b = document.createElement('button'); b.id='decoy'; b.setAttribute('data-row','button'); b.textContent='Save'; document.body.append(b)");
    const ref = (await driver.snapshot({ perception: true })).find(row => row.role === "button" && row.name === "Save")?.ref;
    expect(ref).toBeTypeOf("string");
    const target = await driver.locateRef(ref!);
    await page.evaluate("const s = globalThis.fixture; s.nodes.set(s.ids.get(document.querySelector('#main')), document.querySelector('#decoy'))");
    await expect(driver.click(target, ref)).rejects.toThrow(/expired|ref|continuity/i);
    expect(clicks).toEqual([]);
  });
});
