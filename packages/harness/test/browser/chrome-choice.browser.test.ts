import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { ChromeDevToolsDriver } from "../../src/adapters/drivers/chrome.js";
import { resolveChoiceValues, resolveCollectionTarget, SelectionNotDispatchedError } from "../../src/core/collection.js";
import type { CollectionTarget } from "../../src/core/types.js";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch()); });
afterAll(async () => { await browser?.close(); });

const identity = { kind: "attribute", scope: "item", attribute: "data-resource-id" } as const;
const selection = (): CollectionTarget => ({
  root: { role: "list", name: "Catalog" }, itemRole: "listitem", target: { role: "button", name: "Add" },
  order: "dom", expectedCount: 2,
  choice: { version: 1, cardinality: 1, policy: "first-dom", identity,
    where: [{ kind: "attribute-equals", scope: "item", attribute: "data-available", value: "yes" }], maxReselections: 1 },
});

async function withPage(run: (context: {
  page: Page; driver: ChromeDevToolsDriver; actions: string[];
  hooks: { before?: (name: string, args: Record<string, unknown>) => Promise<void>;
    after?: (name: string, args: Record<string, unknown>) => Promise<void> };
}) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.setContent(`<div data-role="list" role="list" aria-label="Catalog">
      <div id="item-a" data-role="listitem" role="listitem" data-resource-id="A" data-available="yes"><button id="a" data-role="button">Add</button></div>
      <div id="item-b" data-role="listitem" role="listitem" data-resource-id="B" data-available="yes"><button id="b" data-role="button">Add</button></div>
    </div><div data-role="list" role="list" aria-label="Other">
      <div data-role="listitem" role="listitem" data-resource-id="X" data-available="yes"><button id="outside" data-role="button">Add</button></div>
    </div><div id="detail"></div>`);
    await page.evaluate("globalThis.nodes = new Map(); globalThis.uids = new WeakMap(); globalThis.nextUid = 0;");
    const driver = new ChromeDevToolsDriver({ promoteClickables: false });
    // These adapter tests use literals. The session/integration suites cover private
    // binding lookup and authorization; this hook supplies the same resolved inputs.
    Object.defineProperty(driver, resolveChoiceValues, { value: (scope: CollectionTarget) =>
      scope.choice!.where.map(predicate => predicate.value) });
    const actions: string[] = [];
    const hooks: { before?: (name: string, args: Record<string, unknown>) => Promise<void>;
      after?: (name: string, args: Record<string, unknown>) => Promise<void> } = {};
    // Replace only transport. Production measurement/guards run in Chrome; dispatched
    // clicks are real trusted browser events. The separate MCP fixture checks AX output.
    (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
      await hooks.before?.(name, args);
      let output: string;
      if (name === "take_snapshot") output = await page.evaluate<string>(String.raw`(() => {
        return [...document.querySelectorAll('[data-role]')].flatMap(el => [el,
          ...(el.hasAttribute('data-text-action') ? [...el.childNodes].filter(node => node.nodeType === 3) : [])]).filter(node => {
          const el = node.nodeType === 3 ? node.parentElement : node;
          for (let p = el; p; p = p.parentElement)
            if (p.hidden || p.getAttribute('aria-hidden') === 'true' || getComputedStyle(p).display === 'none') return false;
          return true;
        }).map(node => {
          const el = node.nodeType === 3 ? node.parentElement : node;
          let uid = globalThis.uids.get(node);
          if (!uid) { uid = 'choice_' + ++globalThis.nextUid; globalThis.uids.set(node, uid); globalThis.nodes.set(uid, node); }
          const role = node.nodeType === 3 ? 'StaticText' : el.getAttribute('role') || el.dataset.role;
          const name = node.nodeType === 3 ? node.textContent.trim() : el.getAttribute('aria-label') || (role === 'listitem' ? '' : el.textContent.trim());
          let depth = node.nodeType === 3 ? 1 : 0;
          for (let parent = el.parentElement; parent; parent = parent.parentElement) if (parent.hasAttribute('data-role')) depth++;
          return '  '.repeat(depth) + 'uid=' + uid + ' ' + role + (name ? ' ' + JSON.stringify(name) : '') + (el.matches(':disabled') ? ' disabled' : '');
        }).join('\n');
      })()`);
      else if (name === "evaluate_script") output = JSON.stringify(await page.evaluate(
        `(${String(args.function)})(...${JSON.stringify(args.args ?? [])}.map(uid => globalThis.nodes.get(uid)))`));
      else if (name === "list_pages") output = "1: https://fixture.test/catalog [selected]";
      else if (name === "list_network_requests") output = "";
      else if (name === "click") {
        const id = await page.evaluate<string>(`(() => { const node = globalThis.nodes.get(${JSON.stringify(args.uid)});
          return (node.nodeType === 3 ? node.parentElement : node).id; })()`);
        actions.push(id);
        await page.locator(`#${id}`).click();
        output = "";
      } else throw new Error(`unexpected MCP action: ${name}`);
      await hooks.after?.(name, args);
      return output;
    };
    await run({ page, driver, actions, hooks });
  } finally { await page.close(); }
}

test("choice selects the first eligible DOM member and keeps independent scopes separate", async () => {
  await withPage(async ({ page, driver, actions }) => {
    const first = await resolveCollectionTarget(driver, { collection: selection() });
    expect(await driver.clickWithSelectedItemEvidence(first.target, first.ref, identity)).toEqual({ complete: true, value: "A" });
    await page.evaluate("document.querySelector('#item-a').setAttribute('data-available', 'no')");
    const second = await resolveCollectionTarget(driver, { collection: selection() });
    expect(await driver.clickWithSelectedItemEvidence(second.target, second.ref, identity)).toEqual({ complete: true, value: "B" });
    expect(actions).toEqual(["a", "b"]);
  });
});

test("disabled choice candidates are skipped without changing positional disabled-slot behavior", async () => {
  await withPage(async ({ page, driver, actions }) => {
    await page.evaluate("document.querySelector('#a').disabled = true");
    const scoped = selection(), { choice: _choice, ...scope } = scoped;
    await expect(resolveCollectionTarget(driver, { collection: { ...scope, index: 0 } })).rejects.toThrow(/disabled/);
    const chosen = await resolveCollectionTarget(driver, { collection: scoped });
    expect(await driver.clickWithSelectedItemEvidence(chosen.target, chosen.ref, identity)).toEqual({ complete: true, value: "B" });
    expect(actions).toEqual(["b"]);
  });
});

test("action-scoped identity and predicates read the selected action rather than its member", async () => {
  await withPage(async ({ page, driver, actions }) => {
    await page.evaluate(`document.querySelectorAll('button').forEach(button => {
      button.setAttribute('data-action-id', button.id.toUpperCase());
      button.setAttribute('data-action-ready', button.id === 'a' ? 'no' : 'yes');
    })`);
    const scoped = selection(), actionKey = { kind: "attribute", scope: "action", attribute: "data-action-id" } as const;
    scoped.choice!.identity = actionKey;
    scoped.choice!.where = [{ kind: "attribute-equals", scope: "action", attribute: "data-action-ready", value: "yes" }];
    const chosen = await resolveCollectionTarget(driver, { collection: scoped });
    expect(await driver.clickWithSelectedItemEvidence(chosen.target, chosen.ref, actionKey)).toEqual({ complete: true, value: "B" });
    expect(actions).toEqual(["b"]);
  });
});

const textCases = (["choice", "positional"] as const).flatMap(mode =>
  (["item", "action"] as const).map(scope => ({ mode, scope })));

async function staticTextSelection(page: Page, mode: "choice" | "positional", scope: "item" | "action") {
  await page.evaluate(`document.querySelectorAll('button').forEach(button => {
    button.setAttribute('data-text-action', '');
    button.setAttribute('data-action-id', 'action-' + button.id.toUpperCase());
    button.setAttribute('data-action-ready', button.id === 'a' ? 'no' : 'yes');
    button.style.cssText = 'width:100px;height:30px';
  }); document.querySelector('#item-a').setAttribute('data-available', 'no');`);
  const scoped = selection();
  const key = { kind: "attribute" as const, scope, attribute: scope === "item" ? "data-resource-id" : "data-action-id" };
  scoped.target = { role: "StaticText", name: "Add" };
  scoped.choice!.identity = key;
  if (scope === "action") scoped.choice!.where = [
    { kind: "attribute-equals", scope, attribute: "data-action-ready", value: "yes" },
  ];
  const { choice: _choice, ...positional } = scoped;
  const collection: CollectionTarget = mode === "choice" ? scoped : { ...positional, index: 1 };
  return { collection, key };
}

test.each(textCases)("StaticText $mode actions capture the $scope key from an exact Text reference", async ({ mode, scope }) => {
  await withPage(async ({ page, driver, actions }) => {
    const { collection, key } = await staticTextSelection(page, mode, scope);
    const chosen = await resolveCollectionTarget(driver, { collection });
    expect(await page.evaluate(`globalThis.nodes.get(${JSON.stringify(chosen.ref.split(":").at(-1))}).nodeType`)).toBe(3);
    expect(await driver.clickWithSelectedItemEvidence(chosen.target, chosen.ref, key))
      .toEqual({ complete: true, value: scope === "item" ? "B" : "action-B" });
    expect(actions).toEqual(["b"]);
    expect(await page.evaluate("Object.getOwnPropertySymbols(globalThis).filter(s => s.description?.startsWith('cairn-selected-item:')).length")).toBe(0);
  });
});

test.each(textCases.flatMap(testCase => ["changed-key", "reparented-text"].map(change => ({ ...testCase, change }))))(
  "StaticText $mode/$scope $change after receipt preparation stops before dispatch", async ({ mode, scope, change }) => {
    await withPage(async ({ page, driver, actions, hooks }) => {
      const { collection, key } = await staticTextSelection(page, mode, scope);
      const chosen = await resolveCollectionTarget(driver, { collection });
      hooks.after = async (name, args) => {
        if (name !== "evaluate_script" || !String(args.function).includes("const receipt = {document")) return;
        await page.evaluate(change === "changed-key"
          ? `document.querySelector('${scope === "item" ? "#item-b" : "#b"}').setAttribute('${key.attribute}', 'changed')`
          : "const button = document.querySelector('#b'), wrapper = document.createElement('span'); wrapper.append(button.firstChild); button.append(wrapper);");
      };
      await expect(driver.clickWithSelectedItemEvidence(chosen.target, chosen.ref, key)).rejects.toThrow(/collection|expired/);
      expect(actions).toEqual([]);
      expect(await page.evaluate("Object.getOwnPropertySymbols(globalThis).filter(s => s.description?.startsWith('cairn-selected-item:')).length")).toBe(0);
    });
  },
);

test.each(textCases.flatMap(testCase => ["changed-key", "replaced-text"].map(change => ({ ...testCase, change }))))(
  "StaticText $mode/$scope $change on pointerdown cannot confirm the dispatched click", async ({ mode, scope, change }) => {
    await withPage(async ({ page, driver, actions }) => {
      const { collection, key } = await staticTextSelection(page, mode, scope);
      await page.evaluate(`document.querySelector('#b').addEventListener('pointerdown', () => {
        ${change === "changed-key"
          ? `document.querySelector('${scope === "item" ? "#item-b" : "#b"}').setAttribute('${key.attribute}', 'changed');`
          : "document.querySelector('#b').textContent = 'Add';"}
      });`);
      const chosen = await resolveCollectionTarget(driver, { collection });
      expect(await driver.clickWithSelectedItemEvidence(chosen.target, chosen.ref, key)).toEqual({ complete: false });
      expect(actions).toEqual(["b"]);
      expect(await page.evaluate("Object.getOwnPropertySymbols(globalThis).filter(s => s.description?.startsWith('cairn-selected-item:')).length")).toBe(0);
    });
  },
);

test.each([
  "document.querySelector('#item-a').removeAttribute('data-resource-id')",
  "document.querySelector('#item-a').setAttribute('data-resource-id', 'B')",
  "document.querySelector('#item-a').removeAttribute('data-available')",
  "document.querySelector('#item-a').setAttribute('data-available', 'x'.repeat(257))",
  "document.querySelector('#item-a').append(document.querySelector('#a').cloneNode(true))",
  "document.querySelector('#item-a').hidden = true",
  "document.querySelector('#item-a').attachShadow({mode:'open'}).innerHTML = '<slot></slot>'",
])("unknown, ambiguous or unsupported candidate facts cannot authorize dispatch: %s", async mutation => {
  await withPage(async ({ page, driver, actions }) => {
    await page.evaluate(mutation);
    await expect(resolveCollectionTarget(driver, { collection: selection() })).rejects.toThrow(/collection selection/);
    expect(actions).toEqual([]);
  });
});

test("pre-dispatch predicate changes identify the rejected ref and permit a fresh selection", async () => {
  await withPage(async ({ page, driver, actions }) => {
    const first = await resolveCollectionTarget(driver, { collection: selection() });
    await page.evaluate("document.querySelector('#item-a').setAttribute('data-available', 'no')");
    await expect(driver.clickWithSelectedItemEvidence(first.target, first.ref, identity)).rejects.toMatchObject({ ref: first.ref, code: "stale" });
    expect(actions).toEqual([]);
    const second = await resolveCollectionTarget(driver, { collection: selection() });
    expect(await driver.clickWithSelectedItemEvidence(second.target, second.ref, identity)).toEqual({ complete: true, value: "B" });
    expect(actions).toEqual(["b"]);
  });
});

test("reverted predicate changes still invalidate the pre-dispatch observation", async () => {
  await withPage(async ({ page, driver, actions }) => {
    const first = await resolveCollectionTarget(driver, { collection: selection() });
    await page.evaluate("const item = document.querySelector('#item-a'); item.setAttribute('data-available','no'); item.setAttribute('data-available','yes');");
    await expect(driver.clickWithSelectedItemEvidence(first.target, first.ref, identity)).rejects.toBeInstanceOf(SelectionNotDispatchedError);
    expect(actions).toEqual([]);
  });
});

test("a key lost during receipt preparation stops before dispatch", async () => {
  await withPage(async ({ page, driver, actions, hooks }) => {
    const first = await resolveCollectionTarget(driver, { collection: selection() });
    hooks.before = async (name, args) => {
      if (name === "evaluate_script" && String(args.function).includes("const receipt = {document"))
        await page.evaluate("document.querySelector('#item-a').removeAttribute('data-resource-id')");
    };
    await expect(driver.clickWithSelectedItemEvidence(first.target, first.ref, identity)).rejects.toBeInstanceOf(SelectionNotDispatchedError);
    expect(actions).toEqual([]);
  });
});

test("predicate changes after receipt preparation still stop before the MCP click", async () => {
  await withPage(async ({ page, driver, actions, hooks }) => {
    const first = await resolveCollectionTarget(driver, { collection: selection() });
    hooks.after = async (name, args) => {
      if (name === "evaluate_script" && String(args.function).includes("const receipt = {document"))
        await page.evaluate("document.querySelector('#item-a').setAttribute('data-available', 'no')");
    };
    await expect(driver.clickWithSelectedItemEvidence(first.target, first.ref, identity)).rejects.toBeInstanceOf(SelectionNotDispatchedError);
    expect(actions).toEqual([]);
    expect(await page.evaluate("Object.getOwnPropertySymbols(globalThis).filter(s => s.description?.startsWith('cairn-selected-item:')).length")).toBe(0);
  });
});

test("pointerdown eligibility changes yield incomplete evidence after one click, never a retry marker", async () => {
  await withPage(async ({ page, driver, actions }) => {
    await page.evaluate("document.querySelector('#a').addEventListener('pointerdown', () => document.querySelector('#item-a').setAttribute('data-available','no'))");
    const first = await resolveCollectionTarget(driver, { collection: selection() });
    expect(await driver.clickWithSelectedItemEvidence(first.target, first.ref, identity)).toEqual({ complete: false });
    expect(actions).toEqual(["a"]);
  });
});

test("choice evidence cannot capture a different identity declaration", async () => {
  await withPage(async ({ driver, actions }) => {
    const first = await resolveCollectionTarget(driver, { collection: selection() });
    await expect(driver.clickWithSelectedItemEvidence(first.target, first.ref, { ...identity, attribute: "data-other" })).rejects.toThrow(/declared resource key/);
    expect(actions).toEqual([]);
  });
});

test("runtime binding references must be resolved before the Chrome measurement", async () => {
  await withPage(async ({ driver, actions }) => {
    const scoped = selection();
    scoped.choice!.maxReselections = 0;
    scoped.choice!.where[0]!.attribute = identity.attribute;
    scoped.choice!.where[0]!.value = { bindingId: "earlier" };
    const observed = await driver.observeCollection(scoped);
    expect(observed.complete).toBe(false);
    expect(actions).toEqual([]);
  });
});
