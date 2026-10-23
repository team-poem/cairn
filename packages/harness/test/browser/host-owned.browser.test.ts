import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { ChromeDevToolsDriver } from "../../src/adapters/drivers/chrome.js";
import { createHostOwnedRootScope, HOST_ROOT_REGISTRY } from "../../src/adapters/drivers/host-owned-roots.js";
import { conditionMet, waitForCondition } from "../../src/core/steps.js";
import { renderElements } from "../../src/core/discover/prompt.js";
import { deriveActionFindings } from "../../src/core/explore/findings.js";

let browser: Browser;
const fixture = await readFile(new URL("../fixtures/probe/host-owned.html", import.meta.url), "utf8");
beforeAll(async () => { browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch()); });
afterAll(async () => { await browser?.close(); });

async function withFixture(run: (ctx: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const ctx = await setup();
  try { await run(ctx); } finally { await ctx.page.close(); }
}
async function setup() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent(fixture);
  const scope = createHostOwnedRootScope();
  const driver = new ChromeDevToolsDriver({ hostOwnedRoots: scope });
  const registry = `(${HOST_ROOT_REGISTRY})(${JSON.stringify(scope.key)})`;
  const register = (id = "host") => page.evaluate(`(${scope.registerScript})(document.getElementById(${JSON.stringify(id)}))`);
  const unregister = (id = "host") => page.evaluate(`(${scope.unregisterScript})(document.getElementById(${JSON.stringify(id)}))`);
  const actions: string[] = [];
  const hook: { before?: (name: string) => Promise<void> } = {};
  // Only transport is replaced: production capture, filtering, enrichment, guards and dispatch
  // run against real browser DOM objects. The separate MCP smoke test checks actual AX serialization.
  (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
    await hook.before?.(name);
    if (name === "take_snapshot") return page.evaluate(String.raw`(() => {
      globalThis.nodes = Object.fromEntries([...document.querySelectorAll('[data-role]')].map(el => [el.id, el]));
      return Object.entries(globalThis.nodes).map(([id, el]) => 'uid=' + id + ' ' + el.dataset.role + ' "' + el.dataset.name + '"').join('\n');
    })()`);
    if (name === "list_pages") return "0: https://example.test/ [selected]";
    if (name === "list_network_requests") return "";
    if (name === "evaluate_script") return JSON.stringify(await page.evaluate(`(${args.function})(...${JSON.stringify(args.args ?? [])}.map(id => globalThis.nodes?.[id]))`));
    if (name === "click" || name === "hover" || name === "fill" || name === "press_key") { actions.push(`${name}:${args.uid ?? args.key}`); return ""; }
    throw new Error(`unexpected call ${name}`);
  };
  return { page, scope, driver, registry, register, unregister, actions, hook };
}

test.each([false, true])("excludes owned rows from perception=%s without hiding human UI or trusting page markers", async perception => {
  await withFixture(async ({ driver, register, page }) => {
    await register();
    const rows = await driver.snapshot({ perception });
    expect(rows.filter(row => row.role === "button" && row.name === "Save")).toHaveLength(2);
    expect(rows.some(row => row.name.startsWith("Host"))).toBe(false);
    expect(rows.some(row => row.name === "Application control")).toBe(true);
    await expect(page.locator("#host").isVisible()).resolves.toBe(true);
    expect(await page.locator("#host").getAttribute("aria-hidden")).toBeNull();
    await page.locator("#host-save").click();
    expect(await page.locator("body").getAttribute("data-host-clicked")).toBe("yes");
    await page.locator("#host-field").fill("Human operator");
    expect(await page.locator("#host-field").inputValue()).toBe("Human operator");
  });
});

test("no roots registered preserves all candidates and input behavior", async () => {
  await withFixture(async ({ driver, actions }) => {
    expect((await driver.snapshot()).filter(row => row.name === "Save")).toHaveLength(3);
    await driver.pressKey("Tab");
    await driver.click({ text: "Save", role: "button", nth: 2 });
    expect(actions).toEqual(["press_key:Tab", "click:host-save"]);
  });
});

test("named, role/index, nth, selector, exact ref and freeze use one excluded pool", async () => {
  await withFixture(async ({ driver, register, actions }) => {
    await register();
    const rows = await driver.snapshot({ perception: true });
    const saves = rows.filter(row => row.role === "button" && row.name === "Save");
    expect(saves[1]?.ref).toBeTruthy();
    const target = await driver.locateRef(saves[1]!.ref!);
    expect(target).toEqual({ text: "Save", role: "button", index: 1, nth: 1 });
    expect(await driver.locate({ selector: "#second" })).toMatchObject(target);
    await driver.click(target);
    await driver.click({ role: "button", index: 1 });
    await driver.click({ selector: "#first" });
    expect(actions).toEqual(["click:second", "click:second", "click:first"]);
  });
});

test("a host selector cannot fall back to an application button with the same name", async () => {
  await withFixture(async ({ driver, register, actions }) => {
    await register();
    await expect(driver.click({ selector: "#host-save", text: "Save", role: "button", nth: 0 })).rejects.toThrow(/host-owned/);
    await expect(driver.locate({ selector: "#host-save" })).rejects.toThrow(/host-owned/);
    expect(actions).toEqual([]);
  });
});

test("registration without a DOM mutation invalidates refs and cached pools", async () => {
  await withFixture(async ({ driver, register, actions }) => {
    const old = await driver.snapshot({ perception: true });
    const ref = old.find(row => row.name === "Application control")!.ref!;
    await register();
    await expect(driver.locateRef(ref)).rejects.toThrow(/ownership changed/i);
    expect(await driver.locate({ text: "Save", role: "button", nth: 1 })).toMatchObject({ index: 1, nth: 1 });
    expect(actions).toEqual([]);
  });
});

test("ownership change during capture refuses publication", async () => {
  await withFixture(async ({ driver, register, hook }) => {
    let seenPages = false;
    hook.before = async name => { if (name === "list_pages" && !seenPages) { seenPages = true; await register(); } };
    await expect(driver.snapshot({ perception: true })).rejects.toThrow(/ownership changed/i);
  });
});

test("host counter churn does not change semantic snapshots", async () => {
  await withFixture(async ({ driver, register, page }) => {
    await register();
    const first = await driver.snapshot();
    await page.evaluate("document.querySelector('#counter').textContent = document.querySelector('#counter').dataset.name = 'Host count 999'");
    const second = await driver.snapshot();
    expect(second).toEqual(first);
    expect(deriveActionFindings(
      { url: "https://example.test/", requestCount: 0, consoleCount: 0, render: renderElements(first) },
      { url: "https://example.test/", requests: [], console: [], render: renderElements(second) },
      { action: "click", text: "Save", role: "button", nth: 0 }, 0,
    ).some(finding => finding.kind === "dead-action")).toBe(true);
    expect(await conditionMet(driver, { text: "Host-only success" })).toBe(false);
    await expect(waitForCondition(driver, { text: "Host-only success" }, 10)).rejects.toThrow(/timed out/);
  });
});

test("owned text cannot leak through ancestor rows or external labels/descriptions", async () => {
  await withFixture(async ({ driver, register, page }) => {
    await page.evaluate(`(() => {
      document.body.dataset.role='generic'; document.body.dataset.name='Host-only success'; document.body.id='body';
      document.querySelector('#first').setAttribute('aria-labelledby','success');
      document.querySelector('#second').setAttribute('aria-describedby','success');
    })()`);
    await register();
    const rows = await driver.snapshot();
    expect(rows.some(row => row.name === "Host-only success" || row.name === "Save")).toBe(false);
    expect(rows.some(row => row.name === "Application input")).toBe(true);
  });
});

test.each(["detach", "replace", "ancestor", "document"])("%s revokes ownership, never silently transfers it", async kind => {
  await withFixture(async ({ driver, register, page, registry }) => {
    await register();
    await page.evaluate(`(() => {
      const el=document.querySelector('#host');
      if (${JSON.stringify(kind)} === 'detach') { el.remove(); document.body.append(el); }
      if (${JSON.stringify(kind)} === 'replace') el.replaceWith(el.cloneNode(true));
      if (${JSON.stringify(kind)} === 'ancestor') { const body=document.body; body.remove(); document.documentElement.append(body); }
      if (${JSON.stringify(kind)} === 'document') { const html=document.documentElement.outerHTML; document.open(); document.write(html); document.close(); }
    })()`);
    expect(await page.evaluate(`${registry}.status().active`)).toBe(0);
    expect((await driver.snapshot()).some(row => row.name === "Host tools")).toBe(true);
  });
});

test("unregistering exact node restores content, unrelated nodes do not revoke it", async () => {
  await withFixture(async ({ driver, register, unregister }) => {
    await register();
    await unregister("first");
    expect((await driver.snapshot()).some(row => row.name === "Host tools")).toBe(false);
    await unregister();
    expect((await driver.snapshot()).some(row => row.name === "Host tools")).toBe(true);
  });
});

test("owned shadow descendants are excluded; shadow-contained registration is unsupported", async () => {
  await withFixture(async ({ page, registry, register, scope }) => {
    await register();
    expect(await page.evaluate(`(() => {
      const shadow = document.querySelector('#host').attachShadow({mode:'open'});
      const el=shadow.appendChild(document.createElement('button'));
      return ${registry}.excluded(el);
    })()`)).toBe(true);
    await expect(page.evaluate(`(${scope.registerScript})(document.querySelector('#host').shadowRoot.querySelector('button'))`)).rejects.toThrow(/light DOM/);
  });
});

test.each(["body", "documentElement", "detached"])("rejects %s as an ownership root", async kind => {
  await withFixture(async ({ page, scope }) => {
    const expression = kind === "detached" ? "document.createElement('div')" : `document.${kind}`;
    await expect(page.evaluate(`(${scope.registerScript})(${expression})`)).rejects.toThrow(/connected, non-document/);
  });
});

test("active frame boundaries fail explicitly; removing ownership restores observation", async () => {
  await withFixture(async ({ driver, register, unregister, page }) => {
    await register();
    await page.evaluate("document.body.appendChild(document.createElement('iframe'))");
    await expect(driver.snapshot()).rejects.toThrow(/frame boundaries/);
    await expect(driver.pressKey("Enter")).rejects.toThrow(/frame boundaries/);
    await unregister();
    expect((await driver.snapshot()).length).toBeGreaterThan(0);
  });
});

test("owned focused keyboard input and Tab traversal are blocked, application Enter is allowed", async () => {
  await withFixture(async ({ driver, register, page, actions }) => {
    await register();
    await page.locator("#host-field").focus();
    await expect(driver.pressKey("Enter")).rejects.toThrow(/Keyboard input/);
    await page.locator("#field").focus();
    await expect(driver.pressKey("Shift+Tab")).rejects.toThrow(/Tab traversal/);
    await driver.pressKey("Enter");
    expect(actions).toEqual(["press_key:Enter"]);
  });
});

test.each(["click", "hover", "type", "doubleClick"] as const)("owned overlay still blocks %s on application controls", async verb => {
  await withFixture(async ({ driver, register, page, actions }) => {
    await register();
    await page.locator("#host").evaluate(el => el.classList.add("overlay"));
    const target = { text: "Application input", role: "textbox" };
    await expect(verb === "type" ? driver.type(target, "hello") : driver[verb](target)).rejects.toThrow(/host-obstructed/);
    expect(actions).toEqual([]);
  });
});

test("root registration after resolution is still checked before dispatch", async () => {
  await withFixture(async ({ driver, register, hook, actions }) => {
    let measurements = 0;
    hook.before = async name => { if (name === "evaluate_script" && ++measurements === 2) await register("first"); };
    await expect(driver.click({ text: "Save", role: "button", nth: 0 })).rejects.toThrow(/ownership changed|host-owned/i);
    expect(actions).toEqual([]);
  });
});

test("host counter mutations remain visible to settling", async () => {
  await withFixture(async ({ driver, register, page }) => {
    await register();
    await page.evaluate("globalThis.counterTimer = setInterval(() => { document.querySelector('#counter').textContent = String(Date.now()); }, 10)");
    const start = Date.now();
    await driver.settle({ idleMs: 50, pollMs: 15, timeoutMs: 200 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(180);
    await page.evaluate("clearInterval(globalThis.counterTimer)");
  });
});

test("host changes that alter application accessible names invalidate refs", async () => {
  await withFixture(async ({ driver, register, page }) => {
    await register();
    const rows = await driver.snapshot({ perception: true });
    const ref = rows.find(row => row.name === "Application control")!.ref!;
    await page.evaluate("document.querySelector('#spoof').setAttribute('aria-labelledby', 'success')");
    await expect(driver.locateRef(ref)).rejects.toThrow(/host-owned|expired/i);
  });
});

test("unrelated completed host text mutation can keep an app ref, but its new overlay blocks dispatch", async () => {
  await withFixture(async ({ driver, register, page, actions }) => {
    await register();
    const rows = await driver.snapshot({ perception: true });
    const ref = rows.find(row => row.name === "Application control")!.ref!;
    await page.evaluate("document.querySelector('#counter').textContent = 'Host count 1'");
    expect(await driver.locateRef(ref)).toMatchObject({ text: "Application control" });
    await page.evaluate("document.querySelector('#host').classList.add('overlay')");
    await expect(driver.click({}, ref)).rejects.toThrow(/host-obstructed/);
    expect(actions).toEqual([]);
  });
});

test("native select cannot write through an owned overlay", async () => {
  await withFixture(async ({ driver, register, page, actions }) => {
    await page.evaluate(`document.querySelector('main').insertAdjacentHTML('beforeend', '<select id="choice" aria-label="App choice" data-role="combobox" data-name="App choice"><option>One</option><option>Two</option></select>')`);
    await register();
    await page.evaluate("document.querySelector('#host').classList.add('overlay')");
    await expect(driver.select({ text: "App choice", role: "combobox" }, "Two")).rejects.toThrow(/host-obstructed/);
    expect(actions).toEqual([]);
  });
});

test("offscreen dispatch with active ownership refuses unverified automatic scrolling", async () => {
  await withFixture(async ({ driver, register, page, actions }) => {
    await register();
    await page.evaluate("document.querySelector('#first').style.position='absolute'; document.querySelector('#first').style.top='3000px'");
    await expect(driver.click({ text: "Save", role: "button", nth: 0 })).rejects.toThrow(/geometry unavailable/);
    expect(actions).toEqual([]);
    expect(await page.evaluate("scrollY")).toBe(0);
  });
});

test("host-owned cross-role candidates cannot bias app role narrowing", async () => {
  await withFixture(async ({ driver, register, page, actions }) => {
    await page.evaluate(`(() => {
      document.querySelector('#first').outerHTML='<a href="#" id="first" data-role="link" data-name="Save">Save</a>';
      document.querySelector('#first').style.cssText='position:absolute;left:10px;top:10px';
      document.querySelector('#second').style.cssText='position:absolute;left:10px;top:10px;z-index:5;background:white';
    })()`);
    await register();
    await driver.click({ text: "Save" });
    expect(actions).toEqual(["click:second"]);
  });
});

test("the documented Playwright registration and unregistration calls execute on the retained handle", async () => {
  await withFixture(async ({ page, scope, registry }) => {
    const docs = await readFile(new URL("../../../../docs/host-owned-roots.md", import.meta.url), "utf8");
    const examples = [...docs.matchAll(/await panelHandle\.evaluate\([\s\S]*?\n\);/g)].map(match => match[0]);
    expect(examples).toHaveLength(2);
    const panelHandle = await page.$("#host");
    expect(panelHandle).not.toBeNull();
    // Execute the trusted repository examples verbatim, not a hand-rewritten approximation.
    const invoke = (source: string) => new Function("panelHandle", "ownership", `return (async () => { ${source} })()`)(panelHandle, scope);
    await invoke(examples[0]!);
    expect(await page.evaluate(`${registry}.status().active`)).toBe(1);
    await invoke(examples[1]!);
    expect(await page.evaluate(`${registry}.status().active`)).toBe(0);
    await panelHandle!.dispose();
  });
});

test("nested and reflected name dependencies are excluded while sibling Text nodes remain", async () => {
  await withFixture(async ({ page, scope, registry }) => {
    await page.setContent(await readFile(new URL("../fixtures/probe/host-owned-names.html", import.meta.url), "utf8"));
    await page.evaluate(`(${scope.registerScript})(document.getElementById('host'))`);
    const result = await page.evaluate(`(() => {
      const registry=${registry};
      return {
        nested: registry.excluded(document.getElementById('nested')),
        nativeLabel: registry.excluded(document.getElementById('labelled')),
        reflected: registry.excluded(document.getElementById('reflected')),
        nestedReflected: registry.excluded(document.getElementById('nested-reflected')),
        described: registry.excluded(document.getElementById('described')),
        attribute: document.getElementById('reflected').getAttribute('aria-labelledby'),
        appText: registry.excluded([...document.body.childNodes].find(n => n.nodeType === 3 && n.textContent.includes('Application saved'))),
        sharedText: registry.excluded(document.querySelector('section').firstChild),
        hostText: registry.excluded(document.getElementById('host-label').firstChild),
      };
    })()`);
    expect(result).toEqual({ nested: true, nativeLabel: true, reflected: true, nestedReflected: true,
      described: true, attribute: "", appText: false, sharedText: false, hostText: true });
  });
});

test("ordinary large subtrees and cyclic label references do not exhaust the reference bound", async () => {
  await withFixture(async ({ page, registry, register }) => {
    await register();
    expect(await page.evaluate(`(() => {
      const app = document.querySelector('main');
      for (let i=0;i<600;i++) app.appendChild(document.createElement('span')).textContent='Application';
      const a=app.appendChild(document.createElement('span')), b=app.appendChild(document.createElement('span'));
      a.id='cycle-a'; b.id='cycle-b'; a.setAttribute('aria-labelledby','cycle-b'); b.setAttribute('aria-labelledby','cycle-a');
      return ${registry}.excluded(app);
    })()`)).toBe(false);
  });
});
