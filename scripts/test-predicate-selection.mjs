// Real Chrome/MCP predicate selection with independent API records and mutation counters.
// Build first. Set CAIRN_PREDICATE_CASE to one case name for a focused reproduction.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ChromeDevToolsDriver, runScenario, selectedItemEquals } from '../packages/harness/dist/index.js';

const resources = new Map([
  ['A', { id: 'A', name: 'First resource' }],
  ['B', { id: 'B', name: 'Second resource' }],
  ['C', { id: 'C', name: 'Unrelated resource' }],
  ['X', { id: 'X', name: 'Previously added resource' }],
]);
const cases = [
  'first-A', 'first-B', 'A-absent', 'first-eligible-tie', 'scope-isolation',
  'reselect-before-dispatch', 'missing-predicate', 'oversized-predicate',
  'missing-identity', 'duplicate-identity', 'wrong-review', 'changed-on-pointerdown',
  'full-navigation', 'new-tab', 'fixed-A-absent',
  'static-text-item', 'static-text-action',
];
let variant = cases[0];
let added = [], selected = [], reads = [];
let cart = ['X'];
const json = (res, value, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
};

// The cart and review IDs come from independent server records, not copied source DOM fields.
const client = `
  async function request(path, method = 'GET') {
    const response = await fetch(path, { method });
    if (!response.ok) throw new Error('fixture API request failed');
    return response.json();
  }
  async function showCart() {
    const records = await request('/api/cart');
    const list = document.querySelector('#cart');
    list.replaceChildren();
    for (const resource of records) {
      const row = document.createElement('div');
      row.setAttribute('role', 'listitem');
      row.dataset.resourceId = resource.id;
      const button = document.createElement('button');
      button.dataset.resourceId = resource.id;
      button.textContent = 'Select';
      button.addEventListener('click', async () => {
        await request('/api/selection/' + encodeURIComponent(resource.id), 'POST');
        const review = await request('/api/review');
        const detail = document.querySelector('#review');
        detail.dataset.resourceId = review.id;
        detail.textContent = review.name;
        history.pushState({}, '', '/review');
        document.querySelector('#status').textContent = 'Review ready';
      });
      row.append(button);
      list.append(row);
    }
    document.querySelector('#status').textContent = 'Cart ready';
  }
  async function add(resourceId) {
    await request('/api/cart/' + encodeURIComponent(resourceId), 'POST');
    await showCart();
  }
`;
const cartMarkup = '<div id="cart" role="list" aria-label="Cart"></div><h1 id="status">Catalog ready</h1><div id="review"></div>';
const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url, 'http://fixture.local');
  if (url.pathname.startsWith('/api/cart/') && req.method === 'POST') {
    const id = decodeURIComponent(url.pathname.slice('/api/cart/'.length));
    if (!resources.has(id)) { json(res, { error: 'missing resource' }, 404); return; }
    added.push(id);
    cart.push(id);
    json(res, { added: id });
    return;
  }
  if (url.pathname === '/api/cart') {
    reads.push('cart');
    // Simulate data arriving after dispatch, not a synchronous copy in the click handler.
    setTimeout(() => json(res, cart.map(id => resources.get(id))), 60);
    return;
  }
  if (url.pathname.startsWith('/api/selection/') && req.method === 'POST') {
    const id = decodeURIComponent(url.pathname.slice('/api/selection/'.length));
    if (!cart.includes(id)) { json(res, { error: 'resource not in cart' }, 409); return; }
    selected.push(id);
    json(res, { selected: id });
    return;
  }
  if (url.pathname === '/api/review') {
    reads.push('review');
    const id = variant === 'wrong-review' ? 'C' : selected.at(-1);
    setTimeout(() => json(res, resources.get(id) ?? { error: 'nothing selected' }), 60);
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  if (url.pathname.startsWith('/cart-load/')) {
    const id = url.pathname.slice('/cart-load/'.length);
    res.end(`<!doctype html><title>Cart</title>${cartMarkup}<script>${client}
      add(${JSON.stringify(id)}).catch(error => console.error(error));</script>`);
    return;
  }
  const ids = variant === 'A-absent' || variant === 'fixed-A-absent' ? ['B', 'C'] : ['A', 'B'];
  const firstA = ['first-A', 'first-eligible-tie', 'reselect-before-dispatch'].includes(variant);
  const row = id => {
    const identity = variant === 'missing-identity' && id === 'B' ? ''
      : `data-resource-id="${variant === 'duplicate-identity' ? 'B' : id}"`;
    const available = id === 'A' ? firstA : id === 'B' && variant !== 'first-A';
    const eligibility = variant === 'missing-predicate' && id === 'B' ? ''
      : `data-available="${variant === 'oversized-predicate' && id === 'B' ? 'x'.repeat(257) : available}"`;
    return `<div role="listitem" id="item-${id}" ${identity} ${eligibility}>
      <button data-route-id="${id}" data-resource-id="${id}">Add</button></div>`;
  };
  res.end(`<!doctype html><title>Predicate selection fixture</title>
    <div role="list" aria-label="Other catalog"><div role="listitem" data-resource-id="X" data-available="true">
      <button data-route-id="X">Add</button></div></div>
    <div role="list" aria-label="Catalog">${ids.map(row).join('')}</div>${cartMarkup}
    <script>
      const variant = ${JSON.stringify(variant)};
      ${client}
      document.querySelectorAll('[data-route-id]').forEach(button => {
        button.addEventListener('pointerdown', () => {
          if (variant === 'changed-on-pointerdown') button.parentElement.dataset.available = 'false';
        });
        button.addEventListener('click', async () => {
          const id = button.dataset.routeId;
          if (variant === 'full-navigation') { location.href = '/cart-load/' + id; return; }
          if (variant === 'new-tab') { window.open('/cart-load/' + id, '_blank'); return; }
          try { await add(id); } catch (error) { console.error(error); }
        });
      });
    </script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const identity = { kind: 'attribute', scope: 'item', attribute: 'data-resource-id' };
const selection = (name, action, where, maxReselections) => ({
  collection: {
    root: { role: 'list', name }, itemRole: 'listitem', target: { role: 'button', name: action },
    order: 'dom', expectedCount: 2,
    choice: { version: 1, cardinality: 1, policy: 'first-dom', identity, where, maxReselections },
  },
});
const steps = [
  { kind: 'goto', url: `${base}/catalog` },
  { kind: 'click', target: selection('Catalog', 'Add', [
    { kind: 'attribute-equals', scope: 'item', attribute: 'data-available', value: 'true' },
  ], 1), expect: { role: 'heading', text: 'Cart ready' } },
  { kind: 'click', target: selection('Cart', 'Select', [
    { kind: 'attribute-equals', scope: 'item', attribute: 'data-resource-id', value: { bindingId: 'added-item' } },
  ], 0), expect: { role: 'heading', text: 'Review ready' } },
];
const binding = {
  version: 1, id: 'added-item', relation: 'resource-key-equals', phase: 'replay',
  source: { after: steps.slice(0, 2), key: identity },
  destination: { after: steps, key: { kind: 'attribute', selector: '#review', attribute: 'data-resource-id' } },
};
const scenario = {
  name: 'Add one eligible resource and review only that resource', steps,
  assertions: [{ kind: 'custom', name: 'selected-item-equals', params: binding },
    { kind: 'navigated', to: `${base}/review` }],
};
const frozen = JSON.stringify(scenario);
const flags = ['--isolated', '--headless', '--viewport=1280x800', '--no-page-id-routing', '--no-usage-statistics'];
const transport = process.env.CAIRN_MCP_ENTRY
  ? { command: process.execPath, args: [process.env.CAIRN_MCP_ENTRY, ...flags] }
  : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] };
const chosenCases = process.env.CAIRN_PREDICATE_CASE ? [process.env.CAIRN_PREDICATE_CASE] : cases;
try {
  for (variant of chosenCases) {
    assert.ok(cases.includes(variant), `unknown predicate fixture case: ${variant}`);
    added = []; selected = []; reads = []; cart = ['X'];
    const driver = new ChromeDevToolsDriver(transport);
    let clickCalls = 0, changedBeforeDispatch = false;
    const call = driver.call.bind(driver);
    driver.call = async (name, ...args) => {
      if (name === 'click') clickCalls++;
      return call(name, ...args);
    };
    if (variant === 'reselect-before-dispatch') {
      const observe = driver.observeCollection.bind(driver);
      driver.observeCollection = async declaration => {
        const result = await observe(declaration);
        if (!changedBeforeDispatch && declaration.root.name === 'Catalog') {
          changedBeforeDispatch = true;
          // Change the application after a real capture, without replacing its dispatch guards.
          await call('evaluate_script', { function: `() => {
            document.querySelector('#item-A').dataset.available = 'false'; return {};
          }` });
        }
        return result;
      };
    }
    try {
      const fixed = variant === 'fixed-A-absent';
      const input = fixed ? { name: 'Reopen fixed A', steps: [steps[0],
        { kind: 'click', target: { role: 'button', text: 'Add A' } }],
        assertions: [{ kind: 'navigated', to: `${base}/review` }] } : structuredClone(scenario);
      const inputBinding = fixed ? undefined : input.assertions[0].params;
      if (variant.startsWith('static-text-')) {
        for (const step of input.steps.filter(step => step.kind === 'click')) {
          const collection = step.target.collection;
          collection.target.role = 'StaticText';
          if (variant === 'static-text-action') {
            collection.choice.identity.scope = 'action';
            for (const predicate of collection.choice.where)
              if (typeof predicate.value !== 'string') predicate.scope = 'action';
          }
        }
        if (variant === 'static-text-action') inputBinding.source.key.scope = 'action';
      }
      const inputFrozen = JSON.stringify(input);
      const { result } = await runScenario(input, {
        driver, reporter: { async emit() {} }, judgmentKey: 'predicate-selection-fixture-v1',
        selectedItemEvidence: fixed ? undefined : { bindings: [inputBinding], timeoutMs: 15_000 },
        custom: { 'selected-item-equals': selectedItemEquals },
        llm: { id: 'forbidden', async complete() { throw new Error('predicate replay must be model-free'); } },
      });
      const diagnostic = `${variant}: ${JSON.stringify(result)}`;
      const blockedBefore = fixed || ['missing-predicate', 'oversized-predicate', 'missing-identity', 'duplicate-identity'].includes(variant);
      const unconfirmed = ['changed-on-pointerdown', 'full-navigation', 'new-tab'].includes(variant);
      const expectedId = ['first-A', 'first-eligible-tie'].includes(variant) ? 'A' : 'B';
      assert.equal(result.usage.llmCalls, 0, diagnostic);
      assert.equal(result.verdict.passed, !blockedBefore && !unconfirmed && variant !== 'wrong-review', diagnostic);
      assert.deepEqual(added, blockedBefore ? [] : [expectedId], `${variant}: add mutation must occur at most once`);
      assert.deepEqual(selected, blockedBefore || unconfirmed ? [] : [expectedId], `${variant}: only this run's resource may be selected`);
      assert.equal(clickCalls, blockedBefore ? 0 : unconfirmed ? 1 : 2, `${variant}: no duplicate protocol dispatch`);
      assert.deepEqual(reads, blockedBefore ? [] : unconfirmed ? ['cart'] : ['cart', 'review'], diagnostic);
      if (!fixed) {
        const check = result.verdict.results[0];
        if (blockedBefore || unconfirmed) assert.equal(check.reason, 'inconclusive', diagnostic);
        if (variant === 'wrong-review') assert.equal(check.reason, undefined, diagnostic);
      }
      if (variant === 'reselect-before-dispatch') {
        assert.equal(changedBeforeDispatch, true);
        const record = result.evidence.selectedItems.find(item => item.id === binding.id);
        const attempts = record.selectionAttempts.filter(attempt => attempt.actionId === record.sourceActionId);
        assert.deepEqual(attempts.map(attempt => attempt.dispatch), ['not-dispatched', 'dispatched'],
          'only the replacement attempt may dispatch the source mutation');
        assert.equal(record.sourceAttemptId, attempts.at(-1).id, 'source evidence must belong to the replacement attempt');
      }
      assert.equal(JSON.stringify(scenario), frozen, 'replay must not replace frozen binding references with raw keys');
      assert.equal(JSON.stringify(input), inputFrozen, 'replay must preserve this case\'s authored declaration');
      console.log(`${variant}: added=${added.join() || 'none'}, selected=${selected.join() || 'none'}, `
        + `${clickCalls} dispatched clicks, ${result.verdict.passed ? 'passed' : 'rejected'}, 0 model calls`);
    } finally { await driver.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
