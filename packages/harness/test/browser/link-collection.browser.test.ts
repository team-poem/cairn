import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { ChromeDevToolsDriver } from "../../src/adapters/drivers/chrome.js";
import { createHostOwnedRootScope } from "../../src/adapters/drivers/host-owned-roots.js";
import { resolveCollectionTarget } from "../../src/core/collection.js";
import type { LinkCollectionScope, LinkMembership, Target } from "../../src/core/types.js";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch()); });
afterAll(async () => { await browser?.close(); });

// Anchors carry data-role="link" so the transport double below serializes them as AX link rows.
const link = (id: string, extra = "") => `<a id="${id}" data-role="link" href="/posts/${id}"${extra}>${id}</a>`;
const html = `<div class="grid">${["alpha", "bravo", "charlie"].map(id => link(id)).join("")}</div>
  <nav>${link("nav-home")}</nav>`;

function grid(overrides: Partial<LinkCollectionScope> = {}, links: Partial<LinkMembership> = {}): Target {
  return { collection: { links: { scope: ".grid", member: ":scope > a", ...links }, order: "dom", index: 1, expectedCount: 3, ...overrides } };
}

/** `click` replaces the double's no-op click, for example with a real navigation. */
interface Hook {
  before?: (name: string, args: Record<string, unknown>) => Promise<void>;
  snapshot?: (raw: string) => string;
  click?: (id: string) => Promise<void>;
}

async function withPage(run: (ctx: {
  page: Page; driver: ChromeDevToolsDriver; actions: string[]; hook: Hook;
  scope: ReturnType<typeof createHostOwnedRootScope>;
}) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    // An http origin, so link destinations resolve as they do on a served page.
    await page.route(/^https:\/\/(mirror\.)?example\.test\//, route => route.fulfill({ contentType: "text/html", body: `<!doctype html>${html}` }));
    await page.goto("https://example.test/posts");
    await page.evaluate(`(() => { globalThis.nodes = new Map(); globalThis.uids = new WeakMap(); globalThis.nextUid = 0; })()`);
    const scope = createHostOwnedRootScope();
    const driver = new ChromeDevToolsDriver({ promoteClickables: false, hostOwnedRoots: scope });
    const actions: string[] = [];
    const hook: Hook = {};
    // Replace transport only. Production DOM probes, ownership filtering and exact guards run
    // in real Chrome. scripts/test-collection-selection.mjs covers real MCP accessibility output.
    (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
      await hook.before?.(name, args);
      if (name === "take_snapshot") {
        const raw = await page.evaluate<string>(String.raw`(() => {
        const candidates = [...document.querySelectorAll('[data-role]'),
          ...[...document.querySelectorAll('*')].flatMap(el => el.shadowRoot ? [...el.shadowRoot.querySelectorAll('[data-role]')] : [])];
        return candidates.filter(el => {
          for (let p = el; p; p = p.parentElement) if (p.hidden || p.getAttribute('aria-hidden') === 'true' || getComputedStyle(p).display === 'none') return false;
          return true;
        }).map(el => {
          let uid = globalThis.uids.get(el);
          if (!uid) { uid = 'node_' + ++globalThis.nextUid; globalThis.uids.set(el, uid); globalThis.nodes.set(uid, el); }
          const role = el.getAttribute('role') || el.dataset.role;
          const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
          const name = el.getAttribute('aria-label') || labelled || (role === 'listitem' ? '' : el.textContent.trim());
          const state = (el.matches(':disabled') ? ' disabled' : '') + (el.checked ? ' checked' : '') + (typeof el.value === 'string' ? ' value=' + JSON.stringify(el.value) : '');
          let depth = 0;
          for (let parent = el.parentElement; parent; parent = parent.parentElement) if (parent.matches('[data-role]')) depth++;
          return '  '.repeat(depth) + 'uid=' + uid + ' ' + role + (role === 'listitem' && !name ? '' : ' ' + JSON.stringify(name)) + state;
        }).join('\n');
      })()`);
        return hook.snapshot?.(raw) ?? raw;
      }
      if (name === "evaluate_script") return JSON.stringify(await page.evaluate(`(${String(args.function)})(...${JSON.stringify(args.args ?? [])}.map(uid => globalThis.nodes.get(uid)))`));
      if (name === "list_pages") {
        // The MCP listing format: a page-controlled title, then the tab's own URL.
        const title = await page.title();
        return `0: ${title ? `${title} (${page.url()})` : page.url()} [selected]`;
      }
      if (name === "list_network_requests") return "";
      if (["click", "hover", "fill"].includes(name)) {
        const id = await page.evaluate<string>(`(() => {
          const el = globalThis.nodes.get(${JSON.stringify(args.uid)});
          if (!el?.isConnected) throw new Error('detached action');
          return el.id;
        })()`);
        actions.push(`${name}:${id}`);
        if (name === "click") await hook.click?.(id);
        return "";
      }
      throw new Error(`unexpected MCP action: ${name}`);
    };
    await run({ page, driver, actions, hook, scope });
  } finally { await page.close(); }
}

async function clicked(driver: ChromeDevToolsDriver, declaration: Target): Promise<void> {
  const bound = await resolveCollectionTarget(driver, declaration);
  await driver.click(bound.target, bound.ref);
}

test("the second plain link is selected by DOM position, and a reorder selects today's second link", async () => {
  await withPage(async ({ driver, page, actions }) => {
    await clicked(driver, grid());
    await page.evaluate("document.querySelector('.grid').prepend(document.querySelector('#charlie'))");
    await clicked(driver, grid());
    expect(actions).toEqual(["click:bravo", "click:alpha"]);
  });
});

test("DOM order wins over visual order, a badged first card still counts, and off-screen members count", async () => {
  await withPage(async ({ driver, page, actions }) => {
    await page.evaluate(`(() => {
      const grid = document.querySelector('.grid');
      grid.style.display = 'flex'; grid.style.flexDirection = 'row-reverse';
      document.querySelector('#alpha').insertAdjacentHTML('beforeend', '<strong>Official</strong>');
      document.querySelector('#charlie').style.marginTop = '4000px';
    })()`);
    await clicked(driver, grid({ index: 0 }));
    await clicked(driver, grid({ index: 2 }));
    expect(actions).toEqual(["click:alpha", "click:charlie"]);
  });
});

test("wrapped cards group image and title links by destination and click the first link", async () => {
  await withPage(async ({ driver, page, actions }) => {
    await page.evaluate(`document.body.innerHTML = '<section id="feed">' + ['alpha', 'bravo'].map(id =>
      '<article class="card"><a id="' + id + '-image" data-role="link" href="/posts/' + id + '"><img alt="' + id + '" width="20" height="20"></a>' +
      '<a id="' + id + '-title" data-role="link" href="/posts/' + id + '">' + id + '</a></article>').join('') + '</section>'`);
    const cards = (links: Partial<LinkMembership>) => grid({ index: 1, expectedCount: 2 }, { scope: "#feed", member: ":scope > .card", ...links });
    await clicked(driver, cards({ action: "a[href]", group: "destination" }));
    expect(actions).toEqual(["click:bravo-image"]);
    await expect(resolveCollectionTarget(driver, cards({ action: "a[href]" }))).rejects.toMatchObject({ code: "incomplete" });
    await page.evaluate("document.querySelector('#bravo-title').href = '/posts/charlie'");
    await expect(resolveCollectionTarget(driver, cards({ action: "a[href]", group: "destination" }))).rejects.toMatchObject({ code: "incomplete" });
    expect(actions).toEqual(["click:bravo-image"]);
  });
});

test("a hidden member refuses the collection instead of shifting the requested position", async () => {
  await withPage(async ({ driver, page, actions }) => {
    await page.evaluate("document.querySelector('#alpha').style.display = 'none'");
    await expect(resolveCollectionTarget(driver, grid())).rejects.toMatchObject({ code: "incomplete" });
    await expect(resolveCollectionTarget(driver, grid({ expectedCount: 2, index: 0 }))).rejects.toMatchObject({ code: "incomplete" });
    expect(actions).toEqual([]);
  });
});

test("empty, ambiguous, nested, miscounted and invalid scopes fail explicitly", async () => {
  await withPage(async ({ driver, page, actions }) => {
    await expect(resolveCollectionTarget(driver, grid({ expectedCount: 4 }))).rejects.toMatchObject({ code: "incomplete" });
    await expect(resolveCollectionTarget(driver, grid({}, { member: ":scope > a[" }))).rejects.toMatchObject({ code: "invalid" });
    await expect(resolveCollectionTarget(driver, grid({}, { scope: ".missing" }))).rejects.toMatchObject({ code: "missing" });
    await page.evaluate("document.querySelector('#alpha').insertAdjacentHTML('beforeend', '<span>new</span>')");
    await expect(resolveCollectionTarget(driver, grid({}, { member: ":scope > a, :scope > a > span" }))).rejects.toMatchObject({ code: "ambiguous" });
    await page.evaluate("document.body.insertAdjacentHTML('beforeend', '<div class=\\'grid\\'></div>')");
    await expect(resolveCollectionTarget(driver, grid())).rejects.toMatchObject({ code: "ambiguous" });
    expect(actions).toEqual([]);
  });
});

test("a changed destination, order or membership before dispatch refuses the click", async () => {
  for (const change of [
    "document.querySelector('#bravo').href = '/posts/other'",
    "document.querySelector('.grid').prepend(document.querySelector('#charlie'))",
    "document.querySelector('.grid').insertAdjacentHTML('afterbegin', '<a data-role=\\'link\\' href=\\'/posts/new\\'>new</a>')",
  ]) await withPage(async ({ driver, page, actions }) => {
    const bound = await resolveCollectionTarget(driver, grid());
    await page.evaluate(change);
    await expect(driver.click(bound.target, bound.ref)).rejects.toThrow();
    expect(actions).toEqual([]);
  });
});

test("a link destination check dispatches a same-tab link once and refuses other links before dispatch", async () => {
  for (const setup of ["", "document.head.insertAdjacentHTML('beforeend', '<base target=\\'_blank\\'>'); document.querySelector('#bravo').target = '_self'"])
    await withPage(async ({ driver, page, actions }) => {
      await page.evaluate(setup);
      const bound = await resolveCollectionTarget(driver, grid());
      // The transport double does not navigate, so the departure marker survives and nothing is confirmed.
      await expect(driver.clickLinkWithDestination(bound.target, bound.ref)).resolves.toEqual({ complete: false });
      expect(actions).toEqual(["click:bravo"]);
    });
  for (const change of [
    "document.querySelector('#bravo').target = '_blank'",
    "document.head.insertAdjacentHTML('beforeend', '<base target=\\'_blank\\'>')",
    // Chrome treats an empty target as absent, so this link opens in the base target's new tab.
    "document.head.insertAdjacentHTML('beforeend', '<base target=\\'_blank\\'>'); document.querySelector('#bravo').setAttribute('target', '')",
    "document.querySelector('#bravo').setAttribute('target', ' _self')",
    "document.querySelector('#bravo').setAttribute('download', '')",
    "document.querySelector('#bravo').href = '/posts#bravo'",
    "document.querySelector('#bravo').href = 'mailto:bravo@example.test'",
  ]) await withPage(async ({ driver, page, actions }) => {
    await page.evaluate(change);
    const bound = await resolveCollectionTarget(driver, grid());
    await expect(driver.clickLinkWithDestination(bound.target, bound.ref)).rejects.toMatchObject({ code: "unsupported" });
    expect(actions).toEqual([]);
  });
});

/** The browser follows the link as it resolves when the click lands. */
const navigate = (page: Page) => async (id: string) => {
  await Promise.all([page.waitForEvent("framenavigated"), page.click(`#${id}`)]);
};

test("a link destination check confirms a same-tab navigation to the selected link", async () => {
  await withPage(async ({ driver, page, hook }) => {
    hook.click = navigate(page);
    const bound = await resolveCollectionTarget(driver, grid());
    const source = await driver.clickLinkWithDestination(bound.target, bound.ref);
    const arrival = await driver.readLinkArrival();
    expect(source).toEqual({ complete: true, value: "https://example.test/posts/bravo" });
    expect(arrival).toEqual(source);
  });
});

test("a <base href> that differs between the destination read and the final guard cannot confirm the arrival", async () => {
  await withPage(async ({ driver, page, hook }) => {
    await page.evaluate(`document.head.insertAdjacentHTML('beforeend', '<base href="https://example.test/">')`);
    hook.click = navigate(page);
    const bound = await resolveCollectionTarget(driver, grid());
    // A page script swaps the base. Each guard window, from a revision read through its measurement, sees the
    // original base. Every other read and the click itself see the mirror.
    const base = (href: string) => page.evaluate<void>(`(() => { const base = document.querySelector('base');
      if (base && base.getAttribute('href') !== ${JSON.stringify(href)}) base.setAttribute('href', ${JSON.stringify(href)}); })()`);
    let guarding = true, leaving = false;
    hook.before = async (name, args) => {
      if (leaving) { guarding = false; leaving = false; }
      if (name === "click") return base("https://mirror.example.test/");
      if (name !== "evaluate_script") return;
      const script = String(args.function);
      if (script.includes("revision:state.records.length")) guarding = true;
      if (script.includes("const spec =")) leaving = true;
      await base(guarding ? "https://example.test/" : "https://mirror.example.test/");
    };
    const source = await driver.clickLinkWithDestination(bound.target, bound.ref);
    hook.before = undefined;
    const arrival = await driver.readLinkArrival();
    expect(arrival).toEqual({ complete: true, value: "https://mirror.example.test/posts/bravo" });
    // The guarded link pointed at example.test, so arriving at the mirror must not confirm it.
    expect(source.complete && source.value === arrival.value).toBe(false);
  });
});

test("a page title that names the selected link cannot stand in for the arrival", async () => {
  await withPage(async ({ driver, page, hook }) => {
    hook.click = async () => {
      await page.goto("https://example.test/posts/charlie");
      await page.evaluate("document.title = 'Bravo (https://example.test/posts/bravo)'");
    };
    const bound = await resolveCollectionTarget(driver, grid());
    const source = await driver.clickLinkWithDestination(bound.target, bound.ref);
    const arrival = await driver.readLinkArrival();
    expect(source).toEqual({ complete: true, value: "https://example.test/posts/bravo" });
    expect(arrival).toEqual({ complete: true, value: "https://example.test/posts/charlie" });
  });
});
