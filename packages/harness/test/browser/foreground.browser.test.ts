import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { DOM_FOREGROUND_PROBE } from "../../src/adapters/drivers/dom-foreground.js";
import { ChromeDevToolsDriver, perceptionProbeScript } from "../../src/adapters/drivers/chrome.js";
import { selectElements } from "../../src/core/perception.js";
import type { PageElement } from "../../src/core/types.js";

let browser: Browser;
const fixture = await readFile(new URL("../fixtures/probe/foreground.html", import.meta.url), "utf8");
beforeAll(async () => { browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch()); });
afterAll(async () => { await browser?.close(); });
async function withPage(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try { await page.setContent(fixture); await run(page); } finally { await page.close(); }
}
type Facts = Pick<PageElement, "inActivePopup" | "occluded">;

// Same conformance corpus runs through the reusable browser function and the MCP wrapper.
for (const adapter of ["dom", "chrome"] as const) {
  const source = (ids: string[]) => adapter === "dom"
    ? `(...els) => (${DOM_FOREGROUND_PROBE})(...els)`
    : `(...els) => Object.values((${perceptionProbeScript(ids, false)})(...els))`;
  const probe = (page: Page, ids: string[]): Promise<Facts[]> =>
    page.evaluate(`(${source(ids)})(...${JSON.stringify(ids)}.map(id => document.getElementById(id)))`);

  describe(`${adapter} foreground contract`, () => {
    test("markerless overlay survives the cap without claiming offscreen background occlusion", async () => {
      await withPage(async page => {
        const ids = [...Array.from({ length: 140 }, (_, i) => `background-${i}`), "field"];
        const facts = await probe(page, ids);
        expect(facts[0]?.occluded).toBe(true);
        expect(facts[139]).toEqual({});
        expect(facts[140]).toEqual({ inActivePopup: true, occluded: false });
        const rows = ids.map((id, i) => ({ name: id, role: id === "field" ? "textbox" : "button", ...facts[i] }));
        expect(selectElements(rows, "", 60).elements.some(row => row.name === "field")).toBe(true);
        expect(selectElements(rows.map(({ inActivePopup: _, ...row }) => row), "", 60).elements.some(row => row.name === "field")).toBe(false);
      });
    });

    test.each(["dialog", "alertdialog", "native", "popover", "listbox", "menu", "tree", "grid"])("explicit %s semantics work without viewport geometry", async kind => {
      await withPage(async page => {
        const controlled = ["listbox", "menu", "tree", "grid"].includes(kind);
        await page.setContent(`${controlled ? '<button id="opener" aria-expanded="true" aria-controls="popup">Open</button>' : ''}
          ${kind === "native" ? '<dialog id="popup" open>' : `<div id="popup" ${kind === "popover" ? 'popover="manual"' : `role="${kind}"`}>`}
          <input id="field">${kind === "native" ? "</dialog>" : "</div>"}`);
        if (kind === "popover") await page.evaluate("document.querySelector('#popup').showPopover()");
        expect((await probe(page, ["field"]))[0]).toMatchObject({ inActivePopup: true, occluded: false });
        if (["listbox", "menu", "tree", "grid"].includes(kind)) {
          await page.evaluate("document.querySelector('#opener').setAttribute('aria-expanded', 'false')");
          expect((await probe(page, ["field"]))[0]?.inActivePopup).toBeUndefined();
        } else if (kind === "native" || kind === "popover") {
          await page.evaluate(kind === "native" ? "document.querySelector('#popup').close()" : "document.querySelector('#popup').hidePopover()");
          expect((await probe(page, ["field"]))[0]).toEqual({});
        }
      });
    });

    test("aria-owns resolves all whitespace-separated IDs but a disclosure is not a popup", async () => {
      await withPage(async page => {
        await page.setContent('<button aria-expanded="true" aria-owns="missing&#9;popup&#10;region">Open</button><div id="popup" role="listbox"><button id="option">Save</button></div><div id="region"><button id="ordinary">Save</button></div>');
        const facts = await probe(page, ["option", "ordinary"]);
        expect(facts[0]?.inActivePopup).toBe(true);
        expect(facts[1]?.inActivePopup).toBeUndefined();
      });
    });

    test.each(["header", "sidebar", "app", "click-through"])("%s is not inferred to be a foreground overlay", async kind => {
      await withPage(async page => {
        await page.evaluate(`(() => {
          const layer = document.querySelector('#layer');
          if (${JSON.stringify(kind)} === 'header') { layer.style.bottom = 'auto'; layer.style.height = '120px'; }
          if (${JSON.stringify(kind)} === 'sidebar') { layer.style.right = 'auto'; layer.style.width = '250px'; }
          if (${JSON.stringify(kind)} === 'app') document.querySelector('main').remove();
          if (${JSON.stringify(kind)} === 'click-through') { layer.style.pointerEvents = 'none'; document.querySelector('#field').style.pointerEvents = 'auto'; }
          document.querySelector('#panel').style.cssText = 'position:absolute;left:10px;top:10px';
        })()`);
        expect((await probe(page, ["field"]))[0]?.inActivePopup).toBeUndefined();
      });
    });

    test("nested child occlusion removes covered parent priority; recapture reflects close and replacement", async () => {
      await withPage(async page => {
        await page.evaluate(`(() => {
          document.querySelector('#panel').setAttribute('role', 'dialog');
          const child = document.createElement('div'); child.id = 'child'; child.setAttribute('role', 'dialog');
          child.style.cssText = 'position:fixed;inset:0;background:white;z-index:100';
          child.innerHTML = '<input id="child-field">'; document.querySelector('#panel').append(child);
        })()`);
        const facts = await probe(page, ["field", "child-field"]);
        expect(facts[0]).toEqual({ occluded: true });
        expect(facts[1]).toEqual({ occluded: false, inActivePopup: true });
        await page.evaluate("document.querySelector('#child').remove()");
        expect((await probe(page, ["field"]))[0]?.inActivePopup).toBe(true);
        await page.evaluate("document.querySelector('#layer').outerHTML = '<input id=field>'");
        expect((await probe(page, ["field"]))[0]?.inActivePopup).toBeUndefined();
      });
    });

    test.each(["offscreen", "clipped", "transparent", "hidden", "aria-hidden", "zero-size", "clip-path"])("%s candidate remains unknown even inside a dialog", async kind => {
      await withPage(async page => {
        await page.setContent('<div id="parent" role="dialog"><input id="field"></div>');
        await page.evaluate(`(() => {
          const p = document.querySelector('#parent'), el = document.querySelector('#field');
          const kind = ${JSON.stringify(kind)};
          if (kind === 'offscreen') el.style.cssText = 'position:absolute;top:2000px';
          if (kind === 'clipped') { p.style.cssText = 'height:10px;overflow:hidden'; el.style.marginTop = '50px'; }
          if (kind === 'transparent') p.style.opacity = '0';
          if (kind === 'hidden') p.hidden = true;
          if (kind === 'aria-hidden') p.setAttribute('aria-hidden', 'true');
          if (kind === 'zero-size') el.style.cssText = 'width:0;height:0;border:0;padding:0';
          if (kind === 'clip-path') p.style.clipPath = 'circle(2px)';
        })()`);
        expect((await probe(page, ["field"]))[0]).toEqual({});
      });
    });

    test("duplicate labels retain exact membership and probing does not mutate, focus or type", async () => {
      await withPage(async page => {
        await page.evaluate(`(() => {
          globalThis.probeMutations = 0;
          new MutationObserver(records => { globalThis.probeMutations += records.length; }).observe(document, {subtree:true,childList:true,attributes:true,characterData:true});
          globalThis.focusBefore = document.activeElement;
        })()`);
        const facts = await probe(page, ["background-0", "save"]);
        expect(facts[0]?.inActivePopup).toBeUndefined();
        expect(facts[1]?.inActivePopup).toBe(true);
        expect(await page.evaluate("({mutations:globalThis.probeMutations,sameFocus:globalThis.focusBefore===document.activeElement,value:document.querySelector('#field').value,scroll:scrollY})"))
          .toEqual({ mutations: 0, sameFocus: true, value: "", scroll: 0 });
      });
    });

    test("detached, shadow and foreign-document nodes cannot borrow foreground membership", async () => {
      await withPage(async page => {
        const facts = await page.evaluate<Facts[]>(`(() => {
          const detached = document.createElement('input');
          const host = document.querySelector('#panel').appendChild(document.createElement('div'));
          const shadow = host.attachShadow({mode:'open'}); shadow.innerHTML = '<input>';
          const foreign = document.implementation.createHTMLDocument().body.appendChild(document.createElement('input'));
          return (${source(["detached", "shadow", "foreign"])})(detached, shadow.firstChild, foreign);
        })()`);
        expect(facts).toEqual([{}, {}, {}]);
      });
    });

    test("geometry without independent content at several sample points abstains", async () => {
      await withPage(async page => {
        await page.evaluate(`(() => {
          document.querySelector('main').remove();
          const behind = document.createElement('div');
          behind.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:150px;background:gray';
          document.body.prepend(behind);
        })()`);
        expect((await probe(page, ["field"]))[0]?.inActivePopup).toBeUndefined();
      });
    });

    test("root scroll locking does not clip a fixed dialog to a zero-height body", async () => {
      await withPage(async page => {
        await page.setContent('<style>html,body{margin:0;overflow:hidden}body{height:0}</style><div role="dialog" style="position:fixed;inset:0"><input id="field"></div>');
        expect((await probe(page, ["field"]))[0]).toEqual({ inActivePopup: true, occluded: false });
      });
    });

    test.each(["fixed", "absolute", "native", "popover"])("%s popup escapes an ancestor that does not clip its painted box", async kind => {
      await withPage(async page => {
        const native = kind === "native", topLayer = native || kind === "popover";
        await page.setContent(`<div style="width:10px;height:10px;overflow:hidden;${topLayer ? 'transform:translateZ(0)' : ''}">
          <${native ? 'dialog' : 'div'} id="popup" ${kind === "popover" ? 'popover="manual"' : 'role="dialog"'}
            style="position:${kind === 'absolute' ? 'absolute' : 'fixed'};left:400px;top:300px;margin:0"><input id="field"></${native ? 'dialog' : 'div'}></div>`);
        if (topLayer) await page.evaluate(native ? "document.querySelector('#popup').showModal()" : "document.querySelector('#popup').showPopover()");
        expect(await page.evaluate("(()=>{const el=document.querySelector('#field'),b=el.getBoundingClientRect();return document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===el})()")).toBe(true);
        const [facts] = await probe(page, ["field"]);
        expect(facts).toEqual({ inActivePopup: true, occluded: false });
        const background = Array.from({ length: 140 }, (_, i) => ({ role: "button", name: `Background ${i}` }));
        expect(selectElements([...background, { role: "textbox", name: "Field", ...facts }], "", 60).elements.some(row => row.name === "Field")).toBe(true);
      });
    });

    test.each(["native", "popover"])("%s ignores outer top-layer opacity and shape clipping, not inner clipping", async kind => {
      await withPage(async page => {
        const native = kind === "native";
        await page.setContent(`<div id="outer" style="opacity:0;clip-path:circle(1px)"><${native ? 'dialog' : 'div'} id="popup" ${native ? '' : 'popover="manual"'}>
          <div id="inner"><input id="field"></div></${native ? 'dialog' : 'div'}></div>`);
        await page.evaluate(native ? "document.querySelector('#popup').showModal()" : "document.querySelector('#popup').showPopover()");
        expect((await probe(page, ["field"]))[0]).toEqual({ inActivePopup: true, occluded: false });
        await page.evaluate("document.querySelector('#inner').style.cssText='height:10px;overflow:hidden';document.querySelector('#field').style.marginTop='50px'");
        expect((await probe(page, ["field"]))[0]).toEqual({});
        await page.evaluate("document.querySelector('#inner').style.cssText='';document.querySelector('#field').style.marginTop='0';document.querySelector('#outer').style.display='none'");
        expect((await probe(page, ["field"]))[0]).toEqual({});
      });
    });

    test("a transformed containing block still clips its fixed dialog", async () => {
      await withPage(async page => {
        await page.setContent('<div style="width:10px;height:10px;overflow:hidden;transform:translateZ(0)"><div role="dialog" style="position:fixed;left:400px;top:300px"><input id="field"></div></div>');
        expect((await probe(page, ["field"]))[0]).toEqual({});
      });
    });

    test.each([false, true])("restored visibility survives ancestor-first=%s measurement without cache poisoning", async ancestorFirst => {
      await withPage(async page => {
        await page.setContent('<div id="outer" style="visibility:hidden"><div role="dialog" style="visibility:visible"><input id="field"></div><input id="hidden"></div>');
        const ids = ancestorFirst ? ["outer", "hidden", "field"] : ["field", "hidden", "outer"];
        const facts = await probe(page, ids);
        expect(facts[ids.indexOf("field")]).toEqual({ inActivePopup: true, occluded: false });
        expect(facts[ids.indexOf("outer")]).toEqual({});
        expect(facts[ids.indexOf("hidden")]).toEqual({});
        await page.evaluate("document.querySelector('#outer').style.opacity='0'");
        expect((await probe(page, ["field"]))[0]).toEqual({});
      });
    });
  });
}

test("foreground measurements use the owning frame's document, not same-named parent nodes", async () => {
  await withPage(async page => {
    await page.setContent('<button id="field">Save</button><iframe srcdoc=\'<div role="dialog"><button id="field">Save</button></div>\'></iframe>');
    const child = page.frames().find(frame => frame !== page.mainFrame())!;
    await child.waitForSelector("#field");
    const source = `(${DOM_FOREGROUND_PROBE})(document.querySelector('#field'))`;
    expect((await child.evaluate<Facts[]>(source))[0]?.inActivePopup).toBe(true);
    expect((await page.evaluate<Facts[]>(source))[0]?.inActivePopup).toBeUndefined();
  });
});

test.each(["close", "detach", "replace"])("%s of a foreground root expires existing Chrome references", async change => {
  await withPage(async page => {
    await page.setContent('<div id="popup" role="dialog"><button id="save">Save</button></div>');
    await page.evaluate("globalThis.savedForegroundNode = document.querySelector('#save')");
    const driver = new ChromeDevToolsDriver({ promoteClickables: false });
    (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
      if (name === "take_snapshot") return 'uid=save button "Save"';
      if (name === "list_pages") return '0: https://example.test/ [selected]';
      if (name === "evaluate_script") return JSON.stringify(await page.evaluate(`(${args.function})(...${JSON.stringify(args.args ?? [])}.map(() => globalThis.savedForegroundNode))`));
      throw new Error(`Unexpected dispatch after foreground invalidation: ${name}`);
    };
    const [row] = await driver.snapshot({ perception: true });
    expect(row?.inActivePopup).toBe(true);
    expect(row?.ref).toBeTypeOf("string");
    await page.evaluate(`(() => {
      const popup = document.querySelector('#popup');
      if (${JSON.stringify(change)} === 'close') popup.hidden = true;
      if (${JSON.stringify(change)} === 'detach') popup.remove();
      if (${JSON.stringify(change)} === 'replace') popup.replaceWith(popup.cloneNode(true));
    })()`);
    await expect(driver.locateRef(row!.ref!)).rejects.toThrow(/expired/);
  });
});

test("probe scans semantics once per batch and reports reproducible local timings", async () => {
  await withPage(async page => {
    const metrics = await page.evaluate<{ scans: number; p50: number; p95: number }>(`(() => {
      const probe = (${DOM_FOREGROUND_PROBE});
      const nodes = [...document.querySelectorAll('button,input')];
      const original = document.querySelectorAll; let scans = 0;
      document.querySelectorAll = function(...args) { scans++; return original.apply(this,args); };
      try { probe(...nodes); } finally { document.querySelectorAll = original; }
      const times = [];
      for (let i = 0; i < 40; i++) { const start = performance.now(); probe(...nodes); times.push(performance.now()-start); }
      times.sort((a,b) => a-b);
      return { scans, p50: times[20], p95: times[38] };
    })()`);
    expect(metrics.scans).toBe(2);
    // Timing is evidence, not a machine-dependent performance assertion.
    console.log("Foreground probe, 142 candidates, 40 warm iterations:", metrics);
  });
});
