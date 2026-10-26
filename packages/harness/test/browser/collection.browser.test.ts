import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { ChromeDevToolsDriver } from "../../src/adapters/drivers/chrome.js";
import { collectionRows } from "../../src/adapters/drivers/chrome-collection.js";
import { createHostOwnedRootScope } from "../../src/adapters/drivers/host-owned-roots.js";
import { resolveCollectionTarget } from "../../src/core/collection.js";
import type { CollectionTarget, Target } from "../../src/core/types.js";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch()); });
afterAll(async () => { await browser?.close(); });

const html = `<label>Search<input id="query" data-role="textbox" aria-label="Search" value="cats"></label>
  <label><input id="filter" data-role="checkbox" type="checkbox" aria-label="In stock" checked>In stock</label>
  <select id="sort" data-role="combobox" aria-label="Sort"><option value="rank">Relevance</option><option value="name">Name</option></select>
  <ul id="results" data-role="list" aria-label="Results">
    <li id="first-item" data-role="listitem"><button id="first" data-role="button">Open</button>
      <ul id="nested" data-role="list" aria-label="Nested"><li data-role="listitem"><button id="nested-action" data-role="button">Open</button></li></ul></li>
    <li id="second-item" data-role="listitem"><button id="second" data-role="button">Open</button></li>
  </ul>
  <ul id="other" data-role="list" aria-label="Other"><li data-role="listitem"><button id="other-action" data-role="button">Open</button></li></ul>`;

function target(overrides: Partial<CollectionTarget> = {}): Target {
  return { collection: { root: { role: "list", name: "Results" }, itemRole: "listitem", target: { role: "button", name: "Open" },
    order: "dom", index: 0, expectedCount: 2, ...overrides } };
}

async function withPage(run: (ctx: {
  page: Page; driver: ChromeDevToolsDriver; actions: string[];
  hook: { before?: (name: string, args: Record<string, unknown>) => Promise<void>; snapshot?: (raw: string) => string };
  scope: ReturnType<typeof createHostOwnedRootScope>;
}) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.setContent(html);
    await page.evaluate(`(() => { globalThis.nodes = new Map(); globalThis.uids = new WeakMap(); globalThis.nextUid = 0; })()`);
    const scope = createHostOwnedRootScope();
    const driver = new ChromeDevToolsDriver({ promoteClickables: false, hostOwnedRoots: scope });
    const actions: string[] = [];
    const hook: { before?: (name: string, args: Record<string, unknown>) => Promise<void>; snapshot?: (raw: string) => string } = {};
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
      if (name === "list_pages") return "0: https://example.test/results [selected]";
      if (name === "list_network_requests") return "";
      if (["click", "hover", "fill"].includes(name)) {
        const id = await page.evaluate<string>(`(() => {
          const el = globalThis.nodes.get(${JSON.stringify(args.uid)});
          if (!el?.isConnected) throw new Error('detached action');
          return el.id;
        })()`);
        actions.push(`${name}:${id}`);
        return "";
      }
      throw new Error(`unexpected MCP action: ${name}`);
    };
    await run({ page, driver, actions, hook, scope });
  } finally { await page.close(); }
}

test("structural collection parsing retains unnamed items without changing legacy ordinal parsing", () => {
  expect(collectionRows('  uid=1 list "Results"\n    uid=2 listitem level="1"\n      uid=3 button "Open"'))
    .toEqual([{ uid: "1", role: "list", name: "Results" }, { uid: "2", role: "listitem", name: "" }, { uid: "3", role: "button", name: "Open" }]);
  expect(() => collectionRows('uid=1 button "Open "current" result"')).toThrow(/ambiguous quoting/);
  expect(() => collectionRows('uid=1 button "Open \\"current\\" result"')).toThrow(/ambiguous quoting/);
});

test("independent collections, nested exclusion and duplicate labels select exact run-relative nodes", async () => {
  await withPage(async ({ driver, actions, page }) => {
    for (const declaration of [target(), target({ index: 1 }), target({ root: { role: "list", name: "Nested" }, expectedCount: 1 })]) {
      const bound = await resolveCollectionTarget(driver, declaration);
      await driver.click(bound.target, bound.ref);
    }
    await page.evaluate("document.querySelector('#results').prepend(document.querySelector('#second-item'))");
    const again = await resolveCollectionTarget(driver, target());
    await driver.click(again.target, again.ref);
    expect(actions).toEqual(["click:first", "click:second", "click:nested-action", "click:second"]);
  });
});

test("ARIA total and position metadata provides positive coverage without an expectedCount declaration", async () => {
  await withPage(async ({ driver, page, actions }) => {
    await page.evaluate(`document.querySelectorAll('#results > li').forEach((el, i) => { el.setAttribute('aria-setsize','2'); el.setAttribute('aria-posinset', String(i + 1)); })`);
    const bound = await resolveCollectionTarget(driver, target({ expectedCount: undefined, index: 1 }));
    await driver.click(bound.target, bound.ref);
    expect(actions).toEqual(["click:second"]);
  });
});

test("listbox options use their own DOM members, including duplicate option labels", async () => {
  await withPage(async ({ driver, page, actions }) => {
    await page.evaluate(`document.body.innerHTML = '<div id="options" data-role="listbox" role="listbox" aria-label="Choices"><div id="one" data-role="option" role="option">Same</div><div id="two" data-role="option" role="option">Same</div></div>'`);
    const bound = await resolveCollectionTarget(driver, target({ root: { role: "listbox", name: "Choices" }, itemRole: "option", target: { role: "option", name: "Same" }, index: 1 }));
    await driver.click(bound.target, bound.ref);
    expect(actions).toEqual(["click:two"]);
  });
});

test("native multiple and sized listboxes preserve option positions and eligibility", async () => {
  for (const mode of ["multiple", 'size="3"']) await withPage(async ({ driver, page, actions }) => {
    await page.evaluate(`document.body.innerHTML = '<select ${mode} data-role="listbox" aria-label="Choices"><option id="one" data-role="option">Same</option><option id="two" data-role="option">Same</option></select>'`);
    const declaration = target({ root: { role: "listbox", name: "Choices" }, itemRole: "option", target: { role: "option" }, index: 1 });
    const bound = await resolveCollectionTarget(driver, declaration);
    await driver.click(bound.target, bound.ref);
    expect(actions).toEqual(["click:two"]);
    const stale = await resolveCollectionTarget(driver, declaration);
    await page.evaluate("document.querySelector('select').prepend(document.querySelector('#two'))");
    await expect(driver.click(stale.target, stale.ref)).rejects.toThrow(/collection|expired/);
    await page.evaluate("document.querySelector('#one').disabled = true");
    await expect(resolveCollectionTarget(driver, declaration)).rejects.toThrow(/disabled/);
    expect(actions).toEqual(["click:two"]);
  });
});

test("role-only scoped actions retain empty names but still reject ambiguity", async () => {
  await withPage(async ({ driver, page, actions }) => {
    await page.evaluate(`document.querySelector('#first-item').innerHTML = '<button id="first" data-role="button" style="width:100px;height:30px"></button>'`);
    const declaration = target({ target: { role: "button" } });
    const bound = await resolveCollectionTarget(driver, declaration);
    expect(bound.target).toEqual({ text: "", role: "button" });
    await driver.click(bound.target, bound.ref);
    expect(actions).toEqual(["click:first"]);
    await page.evaluate("document.querySelector('#first-item').append(document.querySelector('#first').cloneNode(true))");
    await expect(resolveCollectionTarget(driver, declaration)).rejects.toThrow(/incomplete/);
    expect(actions).toEqual(["click:first"]);
  });
});

test("collection custom select refuses before opening or committing under changed prerequisites", async () => {
  await withPage(async ({ driver, page, actions, hook }) => {
    await page.evaluate("document.querySelector('#first').setAttribute('role','combobox'); document.querySelector('#first').setAttribute('aria-label','Open')");
    const bound = await resolveCollectionTarget(driver, target({ target: { role: "combobox", name: "Open" },
      conditions: [{ control: { role: "textbox", name: "Search" }, value: "cats" }] }));
    hook.before = async name => {
      if (name === "click") await page.evaluate("document.querySelector('#query').value = 'dogs'; document.body.dataset.committed = 'wrong-resource'");
    };
    await expect(driver.select(bound.target, "Chosen", bound.ref)).rejects.toThrow(/collection select requires a native select/);
    expect(actions).toEqual([]);
    expect(await page.evaluate("[document.querySelector('#query').value, document.body.dataset.committed]")).toEqual(["cats", undefined]);
  });
});

test("collection native select still fills its exact control", async () => {
  await withPage(async ({ driver, page, actions }) => {
    await page.evaluate(`document.querySelector('#first-item').innerHTML = '<select id="first" data-role="combobox" aria-label="Choose"><option value="a">A</option><option value="b">B</option></select>'`);
    const bound = await resolveCollectionTarget(driver, target({ target: { role: "combobox", name: "Choose" } }));
    await driver.select(bound.target, "b", bound.ref);
    expect(actions).toEqual(["fill:first"]);
  });
});

test("missing, disabled and ambiguous item actions never shift the selected ordinal", async () => {
  for (const script of [
    "document.querySelector('#first').remove()",
    "document.querySelector('#first').disabled = true",
    "document.querySelector('#first').setAttribute('aria-disabled','true')",
    "document.querySelector('#first-item').appendChild(document.querySelector('#first').cloneNode(true))",
  ]) await withPage(async ({ driver, page, actions }) => {
    await page.evaluate(script);
    await expect(resolveCollectionTarget(driver, target())).rejects.toThrow(/collection selection/);
    expect(actions).toEqual([]);
    const second = await resolveCollectionTarget(driver, target({ index: 1 }));
    await driver.click(second.target, second.ref);
    expect(actions).toEqual(["click:second"]);
  });
});

test("unproven, hidden, virtualized and incomplete collections are refused", async () => {
  for (const script of [
    "document.querySelector('#second-item').hidden = true",
    "document.querySelector('#second-item').removeAttribute('data-role')",
    "document.querySelector('#results').setAttribute('aria-busy','true')",
    "document.querySelector('#first-item').setAttribute('aria-setsize','20')",
    "document.querySelector('#first-item').setAttribute('aria-setsize','-1')",
    "document.querySelector('#first-item').setAttribute('aria-posinset','3')",
    "document.querySelector('#results').setAttribute('aria-rowcount','-1')",
    "document.querySelector('#results').setAttribute('aria-owns','other-action')",
    "document.querySelector('#results').appendChild(document.createElement('div')).attachShadow({mode:'open'})",
    "document.querySelector('#results').appendChild(document.createElement('iframe'))",
  ]) await withPage(async ({ driver, page, actions }) => {
    await page.evaluate(script);
    await expect(resolveCollectionTarget(driver, target())).rejects.toThrow(/collection selection/);
    expect(actions).toEqual([]);
  });
  await withPage(async ({ driver }) => {
    await expect(resolveCollectionTarget(driver, target({ expectedCount: undefined }))).rejects.toThrow(/incomplete/);
    await expect(resolveCollectionTarget(driver, target({ expectedCount: 3 }))).rejects.toThrow(/incomplete/);
    await expect(resolveCollectionTarget(driver, target({ index: 2 }))).rejects.toThrow(/missing/);
  });
});

test("query, filter and sort states are explicit and property-only changes invalidate dispatch", async () => {
  const conditions: CollectionTarget["conditions"] = [
    { control: { role: "textbox", name: "Search" }, value: "cats" },
    { control: { role: "checkbox", name: "In stock" }, checked: true },
    { control: { role: "combobox", name: "Sort" }, value: "rank" },
  ];
  for (const mutation of ["document.querySelector('#query').value = 'dogs'", "document.querySelector('#filter').checked = false", "document.querySelector('#sort').value = 'name'"]) {
    await withPage(async ({ driver, page, actions }) => {
      const bound = await resolveCollectionTarget(driver, target({ conditions }));
      await page.evaluate(mutation);
      await expect(driver.click(bound.target, bound.ref)).rejects.toThrow(/collection|expired/);
      expect(actions).toEqual([]);
      await expect(resolveCollectionTarget(driver, target({ conditions }))).rejects.toThrow(/condition/);
    });
  }
});

const ownershipConditions: CollectionTarget["conditions"] = [
  { control: { role: "textbox", name: "Search" }, value: "cats" },
];

async function prepareIncomingOwnership(page: Page, targetId: string, representation: "attribute" | "property") {
  await page.evaluate(`(() => {
    const root = document.querySelector('#results');
    const wrapper = document.createElement('section'); wrapper.id = 'collection-wrapper';
    root.before(wrapper); wrapper.append(root);
    document.querySelector('#query').parentElement.id = 'query-wrapper';
    globalThis.ownershipTarget = document.getElementById(${JSON.stringify(targetId)});
    globalThis.ownershipOwner = document.querySelector('#other');
    ${representation === "property" ? "globalThis.ownershipTarget.removeAttribute('id');" : ""}
  })()`);
}

async function setIncomingOwnership(page: Page, representation: "attribute" | "property") {
  // Some installed Chrome versions expose this as an expando rather than native ARIA
  // reflection. Either way the guard must conservatively inspect supplied element refs;
  // real MCP coverage separately checks the browser's actual attribute-driven AX reparenting.
  await page.evaluate(representation === "attribute"
    ? "globalThis.ownershipOwner.setAttribute('aria-owns', globalThis.ownershipTarget.id)"
    : "globalThis.ownershipOwner.ariaOwnsElements = [globalThis.ownershipTarget]");
  if (representation === "property") {
    expect(await page.evaluate("[globalThis.ownershipTarget.id, globalThis.ownershipOwner.getAttribute('aria-owns'), globalThis.ownershipOwner.ariaOwnsElements?.[0] === globalThis.ownershipTarget]"))
      .toEqual(["", null, true]);
  }
}

for (const representation of ["attribute", "property"] as const) {
  for (const phase of ["capture", "dispatch"] as const) {
    test.each(["first-item", "first", "results", "collection-wrapper", "query", "query-wrapper"])(
      `incoming ${representation} ownership of %s refuses ${phase} without dispatch`, async targetId => {
        await withPage(async ({ driver, page, actions }) => {
          await prepareIncomingOwnership(page, targetId, representation);
          const declaration = target({ conditions: ownershipConditions });
          if (phase === "capture") {
            await setIncomingOwnership(page, representation);
            await expect(resolveCollectionTarget(driver, declaration)).rejects.toThrow(/collection|ownership/i);
          } else {
            const bound = await resolveCollectionTarget(driver, declaration);
            await setIncomingOwnership(page, representation);
            await expect(driver.click(bound.target, bound.ref)).rejects.toThrow(/collection|expired|ownership/i);
          }
          expect(actions).toEqual([]);
        });
      });
  }

  test(`incoming ${representation} ownership at the final measurement cannot escape earlier validation`, async () => {
    await withPage(async ({ driver, page, actions, hook }) => {
      await prepareIncomingOwnership(page, "first-item", representation);
      const bound = await resolveCollectionTarget(driver, target());
      let validations = 0;
      hook.before = async (name, args) => {
        if (name === "evaluate_script" && String(args.function).includes('const selected = "') && ++validations === 2) {
          await setIncomingOwnership(page, representation);
        }
      };
      await expect(driver.click(bound.target, bound.ref)).rejects.toThrow(/collection|expired|ownership/i);
      expect(validations).toBe(2);
      expect(actions).toEqual([]);
    });
  });

  test(`unrelated ${representation} ownership does not invalidate the selected collection`, async () => {
    await withPage(async ({ driver, page, actions }) => {
      await page.evaluate("const unrelated = document.body.appendChild(document.createElement('span')); unrelated.id = 'unrelated'; unrelated.textContent = 'Unrelated'; globalThis.ownershipTarget = unrelated; globalThis.ownershipOwner = document.querySelector('#other')");
      if (representation === "property") await page.evaluate("globalThis.ownershipTarget.removeAttribute('id')");
      const before = await resolveCollectionTarget(driver, target());
      await setIncomingOwnership(page, representation);
      await driver.click(before.target, before.ref);
      const after = await resolveCollectionTarget(driver, target());
      await driver.click(after.target, after.ref);
      expect(actions).toEqual(["click:first", "click:first"]);
    });
  });
}

test.each(["capture", "dispatch"] as const)("AX-only member reparenting refuses %s even when DOM membership is unchanged", async phase => {
  await withPage(async ({ driver, actions, hook }) => {
    const changeAxParent = (raw: string) => raw.replace(/^\s+(uid=\S+ listitem.*)$/m, "$1");
    if (phase === "capture") {
      hook.snapshot = changeAxParent;
      await expect(resolveCollectionTarget(driver, target())).rejects.toThrow(/collection/i);
    } else {
      const bound = await resolveCollectionTarget(driver, target());
      hook.snapshot = changeAxParent;
      await expect(driver.click(bound.target, bound.ref)).rejects.toThrow(/collection|expired/i);
    }
    expect(actions).toEqual([]);
  });
});

test("a same-name list toolbar action outside all members does not enter the positional pool", async () => {
  await withPage(async ({ driver, page, actions }) => {
    await page.evaluate(`document.querySelector('#results').insertAdjacentHTML('afterbegin', '<button id="toolbar" data-role="button">Open</button>')`);
    const bound = await resolveCollectionTarget(driver, target());
    await driver.click(bound.target, bound.ref);
    expect(actions).toEqual(["click:first"]);
  });
});

test.each([0, 1])("an AX action moved outside its member refuses capture for selected index %s", async index => {
  await withPage(async ({ driver, actions, hook }) => {
    hook.snapshot = raw => {
      const lines = raw.split("\n");
      const source = lines.findIndex(line => /\bbutton "Open"/.test(line));
      const [action] = lines.splice(source, 1);
      const beforeFirstMember = lines.findIndex(line => /\blistitem\b/.test(line));
      // Keep the action under the same list root, but no longer under any listitem.
      lines.splice(beforeFirstMember, 0, action!.replace(/^\s*/, "  "));
      return lines.join("\n");
    };
    await expect(resolveCollectionTarget(driver, target({ index }))).rejects.toThrow(/collection/i);
    expect(actions).toEqual([]);
  });
});

for (const index of [0, 1]) {
  test.each(["capture", "dispatch"] as const)(`AX-only action reparenting refuses %s when selecting member ${index}`, async phase => {
    await withPage(async ({ driver, actions, hook }) => {
      const moveAction = (raw: string) => {
        const lines = raw.split("\n");
        const source = lines.findIndex(line => /\bbutton "Open"/.test(line));
        const [action] = lines.splice(source, 1);
        const afterSecondMember = lines.findIndex(line => /\blist "Other"/.test(line));
        lines.splice(afterSecondMember, 0, action!);
        return lines.join("\n");
      };
      const declaration = target({ index });
      if (phase === "capture") {
        hook.snapshot = moveAction;
        await expect(resolveCollectionTarget(driver, declaration)).rejects.toThrow(/collection/i);
      } else {
        const bound = await resolveCollectionTarget(driver, declaration);
        hook.snapshot = moveAction;
        await expect(driver.click(bound.target, bound.ref)).rejects.toThrow(/collection|expired/i);
      }
      expect(actions).toEqual([]);
    });
  });
}

test.each(["capture", "dispatch"] as const)("external shadow owner element references refuse %s", async phase => {
  await withPage(async ({ driver, page, actions }) => {
    await page.evaluate(`globalThis.ownershipTarget = document.querySelector('#first-item');
      globalThis.ownershipTarget.removeAttribute('id');
      const host = document.body.appendChild(document.createElement('div'));
      globalThis.ownershipOwner = host.attachShadow({mode:'open'}).appendChild(document.createElement('div'));`);
    if (phase === "capture") {
      await setIncomingOwnership(page, "property");
      await expect(resolveCollectionTarget(driver, target())).rejects.toThrow(/collection|ownership/i);
    } else {
      const bound = await resolveCollectionTarget(driver, target());
      await setIncomingOwnership(page, "property");
      await expect(driver.click(bound.target, bound.ref)).rejects.toThrow(/collection|expired|ownership/i);
    }
    expect(actions).toEqual([]);
  });
});

test.each(["attribute", "property"] as const)("outgoing %s ownership on a declared control is unsupported", async representation => {
  await withPage(async ({ driver, page, actions }) => {
    await page.evaluate("globalThis.ownershipOwner = document.querySelector('#query'); globalThis.ownershipTarget = document.querySelector('#other-action')");
    if (representation === "property") await page.evaluate("globalThis.ownershipTarget.removeAttribute('id')");
    await setIncomingOwnership(page, representation);
    await expect(resolveCollectionTarget(driver, target({ conditions: ownershipConditions }))).rejects.toThrow(/collection|ownership/i);
    expect(actions).toEqual([]);
  });
});

test("incoming IDREF tokens cannot hide an owned member among missing or duplicate IDs", async () => {
  await withPage(async ({ driver, page, actions }) => {
    await page.evaluate("document.querySelector('#other').setAttribute('aria-owns', 'missing\\tfirst-item\\nfirst-item  absent')");
    await expect(resolveCollectionTarget(driver, target())).rejects.toThrow(/collection|ownership/i);
    expect(actions).toEqual([]);
  });
});

test("unresolved incoming IDREFs outside the scope do not invalidate selection", async () => {
  await withPage(async ({ driver, page, actions }) => {
    await page.evaluate("document.querySelector('#other').setAttribute('aria-owns', 'missing absent')");
    const bound = await resolveCollectionTarget(driver, target());
    await driver.click(bound.target, bound.ref);
    expect(actions).toEqual(["click:first"]);
  });
});

test.each(["capture", "dispatch"] as const)("shadow-local ownership with a protected member's ID preserves %s", async phase => {
  await withPage(async ({ driver, page, actions }) => {
    await page.evaluate(`const shadow = document.body.appendChild(document.createElement('div')).attachShadow({mode:'open'});
      globalThis.ownershipTarget = shadow.appendChild(document.createElement('span'));
      globalThis.ownershipTarget.id = 'first-item'; globalThis.ownershipTarget.textContent = 'Unrelated shadow target';
      globalThis.ownershipOwner = shadow.appendChild(document.createElement('div'));`);
    expect(await page.evaluate("globalThis.ownershipOwner.getRootNode().getElementById('first-item') === globalThis.ownershipTarget")).toBe(true);
    expect(await page.evaluate("document.getElementById('first-item') === globalThis.ownershipTarget")).toBe(false);
    const before = phase === "dispatch" ? await resolveCollectionTarget(driver, target()) : undefined;
    await setIncomingOwnership(page, "attribute");
    const bound = before ?? await resolveCollectionTarget(driver, target());
    await driver.click(bound.target, bound.ref);
    expect(actions).toEqual(["click:first"]);
  });
});

test.each(["capture", "dispatch"] as const)("ownership of an earlier unrelated duplicate ID preserves %s", async phase => {
  await withPage(async ({ driver, page, actions }) => {
    await page.evaluate(`globalThis.ownershipTarget = document.createElement('span');
      globalThis.ownershipTarget.id = 'first-item'; globalThis.ownershipTarget.textContent = 'Unrelated first ID match';
      document.body.prepend(globalThis.ownershipTarget); globalThis.ownershipOwner = document.querySelector('#other');`);
    expect(await page.evaluate("document.getElementById('first-item') === globalThis.ownershipTarget")).toBe(true);
    const before = phase === "dispatch" ? await resolveCollectionTarget(driver, target()) : undefined;
    await setIncomingOwnership(page, "attribute");
    const bound = before ?? await resolveCollectionTarget(driver, target());
    await driver.click(bound.target, bound.ref);
    expect(actions).toEqual(["click:first"]);
  });
});

test("root, member, action replacement and reorder after resolution reject before dispatch", async () => {
  for (const mutation of [
    "document.querySelector('#results').prepend(document.querySelector('#second-item'))",
    "document.querySelector('#first-item').replaceWith(document.querySelector('#first-item').cloneNode(true))",
    "document.querySelector('#first').replaceWith(document.querySelector('#first').cloneNode(true))",
    "document.querySelector('#results').replaceWith(document.querySelector('#results').cloneNode(true))",
    "document.querySelector('#first').disabled = true",
    "document.querySelector('#first').remove()",
  ]) await withPage(async ({ driver, page, actions }) => {
    const bound = await resolveCollectionTarget(driver, target());
    await page.evaluate(mutation);
    await expect(driver.click(bound.target, bound.ref)).rejects.toThrow(/collection|expired/);
    expect(actions).toEqual([]);
  });
});

test("a mutation at the final dispatch boundary is not hidden by earlier exact-ref validation", async () => {
  await withPage(async ({ driver, page, actions, hook }) => {
    const bound = await resolveCollectionTarget(driver, target());
    let validations = 0;
    hook.before = async (name, args) => {
      if (name === "evaluate_script" && String(args.function).includes('const selected = "') && ++validations === 2) {
        await page.evaluate("document.querySelector('#results').prepend(document.querySelector('#second-item'))");
      }
    };
    await expect(driver.click(bound.target, bound.ref)).rejects.toThrow(/collection|expired/);
    expect(validations).toBe(2);
    expect(actions).toEqual([]);
  });
});

test("external accessible-name dependencies cannot change between AX capture and initial or final measurement", async () => {
  for (const boundary of ["initial", "dispatch"]) await withPage(async ({ driver, page, actions, hook }) => {
    await page.evaluate(`const label = document.body.appendChild(document.createElement('span')); label.id = 'action-label'; label.textContent = 'Open';
      document.querySelector('#first').setAttribute('aria-labelledby', 'action-label');`);
    let validations = 0;
    const mutate = async (name: string, args: Record<string, unknown>) => {
      const source = String(args.function);
      if (name === "evaluate_script" && ((boundary === "initial" && source.includes('const selected = null')) ||
          (boundary === "dispatch" && source.includes('const selected = "') && ++validations === 2))) {
        await page.evaluate("document.querySelector('#action-label').textContent = 'Delete'");
      }
    };
    if (boundary === "initial") {
      hook.before = mutate;
      await expect(resolveCollectionTarget(driver, target())).rejects.toThrow(/collection/);
    } else {
      const bound = await resolveCollectionTarget(driver, target());
      hook.before = mutate;
      await expect(driver.click(bound.target, bound.ref)).rejects.toThrow(/collection|expired/);
      expect(validations).toBe(2);
    }
    expect(actions).toEqual([]);
  });
});

test("registration-only ownership changes at the final measurement expire scoped refs", async () => {
  await withPage(async ({ driver, page, actions, hook, scope }) => {
    const bound = await resolveCollectionTarget(driver, target());
    let validations = 0;
    hook.before = async (name, args) => {
      if (name === "evaluate_script" && String(args.function).includes('const selected = "') && ++validations === 2) {
        await page.evaluate(`(${scope.registerScript})(document.querySelector('#other'))`);
      }
    };
    await expect(driver.click(bound.target, bound.ref)).rejects.toThrow(/collection|expired|ownership/i);
    expect(validations).toBe(2);
    expect(actions).toEqual([]);
  });
});

test("scoped refs tolerate unrelated shadow text without relaxing collection shadow coverage", async () => {
  await withPage(async ({ driver, page, actions }) => {
    await page.evaluate(`document.body.appendChild(document.createElement('div')).attachShadow({mode:'open'}).innerHTML = '<span data-role="StaticText">External shadow text</span><ul><li data-role="listitem"><button data-role="button">Open</button></li></ul>'`);
    const ordinary = await driver.snapshot({ perception: true });
    expect(ordinary.some(row => row.name === "External shadow text")).toBe(true);
    expect(ordinary.every(row => row.ref === undefined)).toBe(true);
    const bound = await resolveCollectionTarget(driver, target());
    expect(bound.ref).toMatch(/^cairn-collection:/);
    await driver.click(bound.target, bound.ref);
    expect(actions).toEqual(["click:first"]);
    await page.evaluate(`document.querySelector('#first-item').appendChild(document.createElement('div')).attachShadow({mode:'open'}).innerHTML = '<span data-role="StaticText">Scoped shadow text</span>'`);
    await expect(resolveCollectionTarget(driver, target())).rejects.toThrow(/collection selection incomplete/);
    expect(actions).toEqual(["click:first"]);
  });
});

test("CSSOM-only obstruction after resolution cannot bypass final action eligibility", async () => {
  await withPage(async ({ driver, page, actions }) => {
    await page.evaluate(`document.head.appendChild(document.createElement('style')).id = 'rules';
      const overlay = document.body.appendChild(document.createElement('div')); overlay.id = 'overlay'; overlay.style.display = 'none';`);
    const bound = await resolveCollectionTarget(driver, target());
    await page.evaluate(`document.querySelector('#rules').sheet.insertRule('#overlay {display:block!important;position:fixed;inset:0;z-index:999;background:white}')`);
    await expect(driver.click(bound.target, bound.ref)).rejects.toThrow(/collection|expired/);
    expect(actions).toEqual([]);
  });
});

test("host-owned duplicate collections stay excluded and later ownership invalidates refs", async () => {
  await withPage(async ({ driver, page, actions, scope }) => {
    await page.evaluate(`(() => { const host = document.querySelector('#results').cloneNode(true); host.id = 'host';
      host.querySelectorAll('[id]').forEach(el => { el.id = 'host-' + el.id; });
      document.body.prepend(host); (${scope.registerScript})(host); })()`);
    const bound = await resolveCollectionTarget(driver, target());
    await driver.click(bound.target, bound.ref);
    expect(actions).toEqual(["click:first"]);
    const later = await resolveCollectionTarget(driver, target());
    await page.evaluate(`(${scope.registerScript})(document.querySelector('#results'))`);
    await expect(driver.click(later.target, later.ref)).rejects.toThrow(/ownership|host-owned/i);
    expect(actions).toEqual(["click:first"]);
  });
});

test("collection freeze stays declarative, direct legacy dispatch refuses, and measurement is read-only", async () => {
  await withPage(async ({ driver, page, actions }) => {
    const declaration = target();
    expect(await driver.locate(declaration)).toEqual(declaration);
    await expect(driver.click(declaration)).rejects.toThrow(/collection selection unsupported/);
    await page.evaluate(`(() => { globalThis.mutations = 0; globalThis.focusBefore = document.activeElement;
      new MutationObserver(records => globalThis.mutations += records.length).observe(document, {subtree:true,childList:true,attributes:true,characterData:true}); })()`);
    const bound = await resolveCollectionTarget(driver, declaration);
    await expect(driver.locateRef(bound.ref)).rejects.toThrow(/retain the collection declaration/);
    expect(await page.evaluate("({mutations:globalThis.mutations,focus:globalThis.focusBefore===document.activeElement,value:document.querySelector('#query').value,scroll:scrollY})"))
      .toEqual({ mutations: 0, focus: true, value: "cats", scroll: 0 });
    expect(JSON.stringify(await driver.locate(declaration))).not.toMatch(/cairn(?:-collection)?:/);
    expect(actions).toEqual([]);
  });
});
