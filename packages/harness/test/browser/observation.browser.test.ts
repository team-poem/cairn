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

type Facts = Record<string, { inActivePopup?: boolean; occluded?: boolean; clickable?: boolean; clickableRegion?: string; actions?: Record<string, string> }>;
async function probe(page: Page, ids: string[], clickables = true, outcomes = false): Promise<Facts> {
  return page.evaluate(`(${perceptionProbeScript(ids, clickables, undefined, undefined, outcomes)})(...${JSON.stringify(ids)}.map(id => document.getElementById(id)))`);
}

test("observationPopupRelation: an expanded control identifies its body-level portal options", async () => {
  await withPage(async page => {
    expect((await probe(page, ["option", "background"])).option).toMatchObject({ inActivePopup: true, occluded: false });
    await page.locator("#opener").evaluate(el => el.setAttribute("aria-expanded", "false"));
    expect((await probe(page, ["option"])).option?.inActivePopup).toBeUndefined();
  });
});

test("perception measures false, mixed and unknown states on their own elements", async () => {
  await withPage(async page => {
    await page.setContent('<button id="mute" aria-pressed="false">Mute</button><button id="plain">Plain</button>' +
      '<input id="check" type="checkbox"><div id="tab" role="tab" aria-selected="false">First</div>' +
      '<button id="disclosure" aria-expanded="false">Details</button>');
    const ids = ["mute", "plain", "check", "tab", "disclosure"];
    const ordinary = await probe(page, ids);
    expect(ordinary.mute).not.toHaveProperty("pressed");
    expect(ordinary.check).not.toHaveProperty("checked");
    const facts = await probe(page, ids, true, true);
    expect(facts.mute).toHaveProperty("pressed", false);
    expect(facts.plain).not.toHaveProperty("pressed");
    expect(facts.check).toHaveProperty("checked", false);
    expect(facts.tab).toHaveProperty("selected", false);
    expect(facts.disclosure).toHaveProperty("expanded", false);
    await page.locator("#mute").evaluate(el => el.setAttribute("aria-pressed", "mixed"));
    expect((await probe(page, ids, true, true)).mute).toHaveProperty("pressed", "mixed");
    await page.locator("#mute").evaluate(el => el.removeAttribute("aria-pressed"));
    expect((await probe(page, ids, true, true)).mute).not.toHaveProperty("pressed");
  });
});

test("value coverage excludes password and CSS-masked text without reading DOM values", async () => {
  await withPage(async page => {
    await page.setContent('<input id="plain"><input id="private" type="password"><input id="mask" style="-webkit-text-security:disc">');
    await page.evaluate(`{
      for (const input of document.querySelectorAll('input'))
        Object.defineProperty(input, 'value', {get() { throw new Error('read of DOM value'); }});
    }`);
    const facts = await probe(page, ["plain", "private", "mask"], true, true);
    expect(facts.plain).toHaveProperty("readableTextValue", true);
    for (const id of ["private", "mask"]) expect(facts[id]).not.toHaveProperty("readableTextValue");
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

test("observationActionEligibility: computed pointer-events none measures pointer actions disallowed, everything else stays unknown", async () => {
  await withPage(async page => {
    await page.setContent(
      '<h1 id="plain">Alpha</h1><button id="none" style="pointer-events:none">Save</button>' +
      '<div id="none-parent" style="pointer-events:none"><button id="reenabled" style="pointer-events:auto">Open</button><span id="inherited">Label</span></div>' +
      '<div id="none-with-child" style="pointer-events:none"><a id="child-link" href="#" style="pointer-events:auto">Go</a></div>' +
      '<div id="none-wide" style="pointer-events:none">' + "<i></i>".repeat(70) + '</div>' +
      '<button id="cursor-hint" style="pointer-events:none;cursor:pointer" onclick="0">Hint</button>');
    const ids = ["plain", "none", "reenabled", "inherited", "none-with-child", "none-wide", "cursor-hint"];
    const facts = await probe(page, ids);
    const pointer = { click: "disallowed", doubleClick: "disallowed", hover: "disallowed" };
    expect(facts.none?.actions).toEqual(pointer);
    expect(facts.inherited?.actions).toEqual(pointer);
    expect(facts["cursor-hint"]?.actions).toEqual(pointer);
    for (const id of ["plain", "reenabled", "none-with-child", "none-wide"]) expect(facts[id]).not.toHaveProperty("actions");
    expect(await probe(page, ["none"], false)).toMatchObject({ none: { actions: pointer } });
  });
});

test("observationActionEligibility: a pointer-events none control a live label still activates stays unknown", async () => {
  await withPage(async page => {
    await page.setContent(
      '<label><input id="wrapped" type="checkbox" style="pointer-events:none"> Wrapped</label>' +
      '<input id="linked" type="checkbox" style="pointer-events:none"><label for="linked">Linked</label>' +
      '<label style="pointer-events:none"><input id="dead-wrapper" type="checkbox" style="pointer-events:none"> Dead</label>' +
      '<input id="dead-linked" type="radio" style="pointer-events:none"><label for="dead-linked" style="pointer-events:none">Dead linked</label>' +
      '<label><button id="in-label" style="pointer-events:none">Go</button></label>');
    const ids = ["wrapped", "linked", "dead-wrapper", "dead-linked", "in-label"];
    const facts = await probe(page, ids);
    const pointer = { click: "disallowed", doubleClick: "disallowed", hover: "disallowed" };
    for (const id of ["wrapped", "linked", "in-label"]) expect(facts[id]).not.toHaveProperty("actions");
    for (const id of ["dead-wrapper", "dead-linked"]) expect(facts[id]?.actions).toEqual(pointer);
    await page.locator("#wrapped").click({ position: { x: 4, y: 4 }, force: true });
    expect(await page.locator("#wrapped").isChecked()).toBe(true);
  });
});

test("observationActionEligibility: a pointer-events none control whose pseudo-element or open shadow child takes the pointer stays unknown", async () => {
  await withPage(async page => {
    await page.setContent(
      '<style>#pseudo::before{content:"";display:block;width:40px;height:20px;pointer-events:auto}' +
      '#pseudo-dead::before{content:"";display:block;width:40px;height:20px}' +
      '#pseudo-nocontent::before{pointer-events:auto}</style>' +
      '<button id="pseudo" style="pointer-events:none" onclick="window.hit=\'pseudo\'"></button>' +
      '<button id="pseudo-dead" style="pointer-events:none"></button>' +
      '<button id="pseudo-nocontent" style="pointer-events:none"></button>' +
      '<div id="host" style="pointer-events:none"></div><div id="host-dead" style="pointer-events:none"></div>' +
      '<div id="host-wide" style="pointer-events:none"></div>' +
      '<div id="host-nested" style="pointer-events:none"></div>');
    await page.evaluate(`(() => {
      const open = (id, html) => { document.getElementById(id).attachShadow({ mode: "open" }).innerHTML = html; };
      open("host", '<button style="pointer-events:auto" onclick="window.hit=\\'shadow\\'">Go</button>');
      open("host-dead", '<button style="pointer-events:none">Go</button>');
      open("host-wide", "<i></i>".repeat(70));
      open("host-nested", '<div id="inner" style="pointer-events:none"></div>');
      document.getElementById("host-nested").shadowRoot.getElementById("inner").attachShadow({ mode: "open" }).innerHTML = '<a href="#" style="pointer-events:auto">Go</a>';
    })()`);
    const ids = ["pseudo", "pseudo-dead", "pseudo-nocontent", "host", "host-dead", "host-wide", "host-nested"];
    const facts = await probe(page, ids);
    const pointer = { click: "disallowed", doubleClick: "disallowed", hover: "disallowed" };
    for (const id of ["pseudo", "host", "host-wide", "host-nested"]) expect(facts[id]).not.toHaveProperty("actions");
    for (const id of ["pseudo-dead", "pseudo-nocontent", "host-dead"]) expect(facts[id]?.actions).toEqual(pointer);
    await page.locator("#pseudo").click({ position: { x: 14, y: 14 }, force: true });
    expect(await page.evaluate("window.hit")).toBe("pseudo");
    await page.locator("#host button").click({ force: true });
    expect(await page.evaluate("window.hit")).toBe("shadow");
  });
});
