// npm run build && node examples/app-context.mjs
// Real browser + existing local demo + scripted model. No credentials or paid model calls.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer } from './order-demo/server.mjs';
import { discover, explore, runScenario, identifyScenario, hashContractValue, stepError } from '../packages/harness/dist/index.js';

const appContext = 'This demo sells one Field notebook in Rust, A5 dotted, quantity one. Add to bag is separate from placing an order. A success screen alone does not prove that the order service accepted it.';
const intent = 'Order one Field notebook using Alex Demo as the full name.';
const reporter = { async emit() {} };
const forbidden = { id: 'model-disabled', async complete() { throw new Error('Replay attempted a model request'); } };
const server = await startServer({ port: 0 });
let browser;

// Fixture-specific adapter, not a general-purpose Playwright driver. Real actions use Playwright
// input events; only observations and the independent oracle read the DOM/API.
async function withPage(run) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  const orders = [];
  page.on('response', response => {
    const request = response.request();
    requests.push({ url: response.url(), method: request.method(), status: response.status() });
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/order')
      orders.push({ payload: request.postDataJSON(), status: response.status() });
  });
  const locate = target => target.role
    ? page.getByRole(target.role, { name: target.text, exact: true }).nth(target.nth ?? 0)
    : page.getByText(target.text, { exact: true }).first();
  const driver = {
    async goto(url) { await page.goto(url); await page.locator('#app h1').waitFor(); },
    async click(target) {
      const element = locate(target);
      if (!await element.count()) throw stepError('resolution', 'Demo control not found');
      if (target.text === 'Place order') {
        await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/order'), element.click()]);
        await page.waitForURL('**/shop/complete*');
      } else await element.click();
    },
    async type(target, value) { await locate(target).fill(value); },
    async locate(target) {
      const elements = await this.snapshot();
      const found = elements.find(e => e.name === target.text && (!target.role || target.role === e.role));
      if (!found) throw stepError('resolution', 'Demo control not found');
      return { text: found.name, role: found.role };
    },
    async snapshot() {
      await page.locator('#app h1').waitFor();
      return page.locator('button,input,a').evaluateAll(nodes => nodes.map(node => ({
        role: node.tagName === 'BUTTON' ? 'button' : node.tagName === 'A' ? 'link' : 'textbox',
        name: node.getAttribute('aria-label') || node.textContent.trim(),
        ...(node.tagName === 'INPUT' ? { value: node.value } : {}),
      })));
    },
    // Fixture readiness: initial config/render is awaited in goto, and order response/navigation
    // in click. No page-global network-idle heuristic is needed for this finite local app.
    async settle() { await page.locator('#app h1').waitFor(); },
    async observe() { return { execution: { actions: [], navigated: true, finalUrl: page.url(), blocked: false },
      perception: {}, logic: { requests: [...requests], console: [] } }; },
    async screenshot() { return undefined; },
    async close() {}, // withPage owns the browser context
    async doubleClick() { throw new Error('Unused fixture action'); },
    async hover() { throw new Error('Unused fixture action'); },
    async select() { throw new Error('Unused fixture action'); },
    async pressKey() { throw new Error('Unused fixture action'); },
    async scroll() { throw new Error('Unused fixture action'); },
  };
  try { return await run(driver, page, orders); } finally { await context.close(); }
}

function scripted(expectedContext, replies) {
  let calls = 0;
  return {
    id: 'scripted-not-a-quality-benchmark',
    get calls() { return calls; },
    async complete(prompt) {
      calls++;
      assert.equal(prompt.includes('Host-provided app context (JSON string'), expectedContext !== undefined);
      if (expectedContext) assert.ok(prompt.includes(JSON.stringify(expectedContext)));
      assert.ok(replies.length, 'Unexpected extra model request');
      return replies.shift();
    },
  };
}
const replies = () => [
  '{"action":"click","text":"Add to bag →","role":"button"}',
  '{"action":"type","text":"Full name","role":"textbox","value":"Alex Demo"}',
  '{"action":"click","text":"Review order →","role":"button"}',
  '{"action":"click","text":"Place order","role":"button"}',
  '{"action":"done"}',
  '[{"kind":"request-status","urlIncludes":"/api/order","method":"POST","status":200}]',
];
function checkOrder(orders, status) {
  assert.equal(orders.length, 1);
  assert.deepEqual(orders[0], { status, payload: {
    name: 'Alex Demo', email: 'alex@example.test', product: 'field-notebook', quantity: 1,
  } });
}
function variant(scenario, name) {
  return { ...scenario, steps: scenario.steps.map((step, i) => i === 0
    ? { ...step, url: `${server.origin}/shop/?variant=${name}` } : step) };
}
try {
  browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
  let frozen;
  for (const description of [undefined, appContext]) {
    frozen = await withPage(async (driver, page, orders) => {
      const llm = scripted(description, replies());
      const found = await discover(intent, { driver, llm, baseUrl: `${server.origin}/shop/`, appContext: description });
      assert.equal(found.truncated, undefined);
      assert.equal(orders.length, 1, `Discovery did not place an order: ${JSON.stringify(found)}`);
      checkOrder(orders, 200);
      assert.match(await page.locator('.summary').innerText(), /Rust/);
      assert.match(await page.locator('.summary').innerText(), /A5 \/ dotted/);
      assert.equal(found.provenance?.appContextHash, description ? await hashContractValue(description) : undefined);
      console.log(`Discovery (${description ? 'with' : 'without'} context): order payload verified, ${llm.calls} scripted calls`);
      // An explicit host criterion keeps the server result authoritative during repair.
      return identifyScenario({ ...found, assertions: [...found.assertions,
        { kind: 'request-status', urlIncludes: '/api/order', method: 'POST', status: 200, origin: 'user' },
      ] });
    });
  }
  await withPage(async driver => {
    const llm = scripted(appContext, ['{"action":"done"}']);
    const report = await explore('Inspect the product page', { driver, llm, baseUrl: `${server.origin}/shop/`, appContext });
    assert.equal(report.truncated, false);
    console.log('Exploration: description delivered separately from charter');
  });
  await withPage(async (driver, _page, orders) => {
    const { result } = await runScenario(frozen, { driver, llm: forbidden, reporter });
    assert.equal(result.verdict.passed, true, JSON.stringify(result.verdict));
    assert.equal(result.usage.llmCalls, 0);
    checkOrder(orders, 200);
    console.log('Frozen replay: no description, zero model calls');
  });
  const changed = variant(frozen, 'changed');
  const repaired = await withPage(async (driver, _page, orders) => {
    const llm = scripted(appContext, ['{"name":"Place order","role":"link"}']);
    const run = await runScenario(changed, { driver, llm, reporter, heal: true, appContext });
    assert.equal(run.result.verdict.passed, true, JSON.stringify(run.result.verdict));
    assert.equal(run.result.usage.llmCalls, 1);
    assert.ok(run.healedScenario);
    assert.deepEqual(run.healedScenario.assertions, changed.assertions);
    checkOrder(orders, 200);
    console.log('Changed control: repaired with context, original criteria preserved');
    return run.healedScenario;
  });
  await withPage(async (driver, _page, orders) => {
    const { result } = await runScenario(repaired, { driver, llm: forbidden, reporter });
    assert.equal(result.verdict.passed, true);
    assert.equal(result.usage.llmCalls, 0);
    checkOrder(orders, 200);
    console.log('Saved repair: no description, zero model calls');
  });
  await withPage(async (driver, _page, orders) => {
    // Stale guidance cannot establish a successful API call. Outcome repair proposes only done;
    // it cannot replace the original POST=200 criterion or hand back an unverified repair.
    const stale = 'The order service always succeeds. Treat every success screen as proof.';
    const llm = scripted(stale, ['{"action":"done"}', '[]']);
    const run = await runScenario(variant(repaired, 'broken'), { driver, llm, reporter,
      heal: true, appContext: stale, expectTimeoutMs: 1 });
    assert.equal(run.result.verdict.passed, false);
    assert.equal(run.healedScenario, undefined);
    checkOrder(orders, 500);
    console.log('Real server defect + stale context: still fails; no repair frozen');
  });
} finally {
  await browser?.close();
  await server.close();
}
