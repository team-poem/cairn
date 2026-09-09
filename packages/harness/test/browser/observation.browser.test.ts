import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { perceptionProbeScript } from "../../src/adapters/drivers/chrome.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
});
afterAll(async () => { await browser?.close(); });

async function withPage(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.setContent(await readFile(new URL("../fixtures/probe/observation-facts.html", import.meta.url), "utf8"));
    await run(page);
  } finally { await page.close(); }
}

type Facts = Record<string, { inActivePopup?: boolean; occluded?: boolean; clickable?: boolean; clickableRegion?: string }>;
async function probe(page: Page, ids: string[], clickables = true): Promise<Facts> {
  return page.evaluate(`(${perceptionProbeScript(ids, clickables)})(...${JSON.stringify(ids)}.map(id => document.getElementById(id)))`);
}

test("observationPopupRelation: an expanded control identifies its body-level portal options", async () => {
  await withPage(async page => {
    expect((await probe(page, ["option", "background"])).option).toMatchObject({ inActivePopup: true, occluded: false });
    await page.locator("#opener").evaluate(el => el.setAttribute("aria-expanded", "false"));
    expect((await probe(page, ["option"])).option?.inActivePopup).toBeUndefined();
  });
});

test("observationOcclusionEvidence: covered is positive, offscreen and clipped fixed nodes are unknown", async () => {
  await withPage(async page => {
    const facts = await probe(page, ["background", "offscreen", "fixed-clipped"]);
    expect(facts.background?.occluded).toBe(true);
    expect(facts.offscreen?.occluded).toBeUndefined();
    expect(facts["fixed-clipped"]?.occluded).toBeUndefined();
    expect(await page.evaluate('document.querySelector("#scroller").scrollTop')).toBe(0);
  });
});

test("observationDelegatedClick: cursor candidates include delegated handlers without inventing roles", async () => {
  await withPage(async page => {
    const facts = await probe(page, ["card", "card-label"]);
    expect(facts.card?.clickable).toBe(true);
    expect(facts["card-label"]?.clickable).toBe(true);
    expect(facts.card?.clickableRegion).toBe(facts["card-label"]?.clickableRegion);
    await page.locator("#card-label").click();
    expect(await page.locator("body").getAttribute("data-clicked")).toBe("card");
    expect(await page.locator("#card").getAttribute("role")).toBeNull();
    expect((await probe(page, ["card-label"], false))["card-label"]?.clickable).toBeUndefined();
  });
});

test("observationDetachedAndShadow: unavailable or shadow hit tests never fabricate occlusion", async () => {
  await withPage(async page => {
    const result = await page.evaluate<Facts>(`(() => {
      const detached = document.createElement('button');
      const host = document.body.appendChild(document.createElement('div'));
      const root = host.attachShadow({mode:'open'});
      root.innerHTML = '<button>Shadow</button>';
      return (${perceptionProbeScript(["detached", "shadow"])})(detached, root.querySelector('button'));
    })()`);
    expect(result.detached).toEqual({});
    expect(result.shadow?.occluded).toBeUndefined();
  });
});

test("observationCardInsideDialog: a semantic container preserves the nested clickable region", async () => {
  await withPage(async page => {
    await page.evaluate("document.querySelector('#card').parentElement.setAttribute('role', 'dialog')");
    const facts = await probe(page, ["card", "card-label"]);
    expect(facts.card?.clickable).toBe(true);
    expect(facts["card-label"]?.clickableRegion).toBe(facts.card?.clickableRegion);
  });
});

test("observationStructuralDrift: inserting an identical sibling invalidates locators before freezing", async () => {
  await withPage(async page => {
    const { ChromeDevToolsDriver } = await import("../../src/adapters/drivers/chrome.js");
    const driver = new ChromeDevToolsDriver({ promoteClickables: false });
    await page.setContent('<button id="first">Save</button><button id="second">Save</button>');
    await page.evaluate("globalThis.observedNodes = {first: document.querySelector('#first'), second: document.querySelector('#second')}");
    (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
      if (name === "take_snapshot") return 'uid=first button "Save"\nuid=second button "Save"';
      if (name === "list_pages") return '0: https://example.test/ [selected]';
      if (name === "evaluate_script") return JSON.stringify(await page.evaluate(`(${args.function})(...${JSON.stringify(args.args ?? [])}.map(id => globalThis.observedNodes[id]))`));
      throw new Error(`unexpected action: ${name}`);
    };
    const rows = await driver.snapshot({ perception: true });
    expect(await driver.locateRef(rows[1]!.ref!)).toMatchObject({ nth: 1 });
    await page.evaluate("document.querySelector('#first').before(document.querySelector('#first').cloneNode(true))");
    await expect(driver.locateRef(rows[1]!.ref!)).rejects.toThrow(/expired/);
  });
});

test("observationNodeReplacement: identical text does not preserve the captured DOM node", async () => {
  await withPage(async page => {
    const { ChromeDevToolsDriver } = await import("../../src/adapters/drivers/chrome.js");
    const driver = new ChromeDevToolsDriver({ promoteClickables: false });
    await page.evaluate("globalThis.observedNode = document.querySelector('#opener')");
    (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
      if (name === "take_snapshot") return 'uid=node button "Account"';
      if (name === "list_pages") return '0: https://example.test/ [selected]';
      if (name === "evaluate_script") return JSON.stringify(await page.evaluate(`(${args.function})(...${JSON.stringify(args.args ?? [])}.map(() => globalThis.observedNode))`));
      throw new Error(`unexpected action: ${name}`);
    };
    const [row] = await driver.snapshot({ perception: true });
    await page.evaluate("globalThis.observedNode.replaceWith(globalThis.observedNode.cloneNode(true))");
    await expect(driver.click({ text: "Account" }, row!.ref)).rejects.toThrow(/expired/);
  });
});

test("observationShadowGuard: unobserved shadow mutations cannot produce exact references", async () => {
  await withPage(async page => {
    const { ChromeDevToolsDriver } = await import("../../src/adapters/drivers/chrome.js");
    const driver = new ChromeDevToolsDriver({ promoteClickables: false });
    await page.evaluate(`(() => {
      const host = document.body.appendChild(document.createElement('div'));
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<button>Save</button>';
      const light = document.body.appendChild(document.createElement('button'));
      light.textContent = 'Save';
      globalThis.shadowNodes = [root.querySelector('button'), light];
    })()`);
    (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
      if (name === "take_snapshot") return 'uid=0 button "Save"\nuid=1 button "Save"';
      if (name === "list_pages") return '0: https://example.test/ [selected]';
      if (name === "evaluate_script") return JSON.stringify(await page.evaluate(`(${args.function})(...${JSON.stringify(args.args ?? [])}.map(id => globalThis.shadowNodes[Number(id)]))`));
      throw new Error(`unexpected action: ${name}`);
    };
    const rows = await driver.snapshot({ perception: true });
    expect(rows.map(({ name, role }) => ({ name, role }))).toEqual([
      { name: "Save", role: "button" }, { name: "Save", role: "button" },
    ]);
    expect(rows.every(row => row.ref === undefined)).toBe(true);
    await page.evaluate('globalThis.shadowNodes[0].before(globalThis.shadowNodes[0].cloneNode(true))');
    expect(rows.every(row => row.ref === undefined)).toBe(true);
  });
});

test("observationAccessibleValueDrift: changing input button names expires duplicate ordinals", async () => {
  await withPage(async page => {
    const { ChromeDevToolsDriver } = await import("../../src/adapters/drivers/chrome.js");
    const driver = new ChromeDevToolsDriver({ promoteClickables: false });
    await page.setContent('<input type="button" value="Save"><input type="button" value="Save">');
    await page.evaluate("globalThis.inputs = [...document.querySelectorAll('input')]");
    (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
      if (name === "take_snapshot") return 'uid=0 button "Save"\nuid=1 button "Save"';
      if (name === "list_pages") return '0: https://example.test/ [selected]';
      if (name === "evaluate_script") return JSON.stringify(await page.evaluate(`(${args.function})(...${JSON.stringify(args.args ?? [])}.map(id => globalThis.inputs[Number(id)]))`));
      throw new Error(`unexpected action: ${name}`);
    };
    const rows = await driver.snapshot({ perception: true });
    expect(await driver.locateRef(rows[1]!.ref!)).toMatchObject({ nth: 1 });
    await page.evaluate("globalThis.inputs[0].setAttribute('value', 'Cancel')");
    await expect(driver.locateRef(rows[1]!.ref!)).rejects.toThrow(/expired/);
  });
});

test("observationDocumentCoverage: a captured RootWebArea does not disable guarded element refs", async () => {
  await withPage(async page => {
    const { ChromeDevToolsDriver } = await import("../../src/adapters/drivers/chrome.js");
    const driver = new ChromeDevToolsDriver({ promoteClickables: false });
    (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
      if (name === "take_snapshot") return 'uid=document RootWebArea "Fixture"\nuid=opener button "Account"';
      if (name === "list_pages") return '0: https://example.test/ [selected]';
      if (name === "evaluate_script") return JSON.stringify(await page.evaluate(`(${args.function})(...${JSON.stringify(args.args ?? [])}.map(id => id === 'document' ? document : document.getElementById(id)))`));
      throw new Error(`unexpected action: ${name}`);
    };
    const rows = await driver.snapshot({ perception: true });
    expect(rows[1]!.ref).toBeTypeOf("string");
    expect(await driver.locateRef(rows[1]!.ref!)).toMatchObject({ text: "Account", role: "button" });
  });
});
