// Real Chrome/MCP regression for #259. No hosted model or private transport patch.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { ChromeDevToolsDriver, runScenario } from '../packages/harness/dist/index.js';
import { startFixture, reservePort } from '../bench/local/server.mjs';

const mcp = process.env.CAIRN_MCP_ENTRY;
const flags = ['--isolated', '--headless', '--no-page-id-routing', '--no-usage-statistics'];
const options = mcp ? { command: process.execPath, args: [mcp, ...flags] }
  : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] };
const reporter = { async emit() {} };
const report = [];
let calls = 0;
const forbidden = { id: 'no-model', async complete() { calls++; throw new Error('Unexpected model call'); } };
const order = { kind: 'request-status', urlIncludes: '/api/order', method: 'POST', status: 200, origin: 'user' };
const expectOrder = { requestStatus: { urlIncludes: '/api/order', method: 'POST', status: 200 } };

async function withBrowser(run) {
  const driver = new ChromeDevToolsDriver(options);
  try { return await run(driver); } finally { await driver.close(); }
}
function checkout(origin) {
  return { name: 'Place the one-book order', steps: [
    { kind: 'goto', url: `${origin}/login` },
    { kind: 'type', target: { text: 'Username', role: 'textbox' }, text: 'alice' },
    { kind: 'click', target: { text: 'Log in', role: 'button' }, expect: { url: '/products' } },
    { kind: 'click', target: { text: 'Add to cart', role: 'button' }, expect: { requestStatus: { urlIncludes: '/api/cart', method: 'POST', status: 200 } } },
    { kind: 'click', target: { text: 'Cart', role: 'link' }, expect: { url: '/cart' } },
    { kind: 'click', target: { text: 'Place order', role: 'button', index: 0 }, intent: 'Place the one-book order', expect: expectOrder },
    { kind: 'waitFor', until: { url: '/done' } },
  ], assertions: [order, { kind: 'navigated', to: `${origin}/done`, origin: 'user' }] };
}

// The original #230 fixture: keep the same POST and destination criteria as #256.
const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
let frozen = checkout(origin);
for (const phase of ['original', 'repair', 'replay']) {
  const server = await startFixture({ tier: 'stateful', version: phase === 'original' ? 'v1' : 'v3',
    runIndex: 0, latency: { document: [0], api: [0] }, port });
  try {
    await withBrowser(async driver => {
      let repairCalls = 0;
      const llm = phase === 'repair' ? { id: 'scripted-locator', async complete() {
        repairCalls++;
        assert.equal(repairCalls, 1, 'No surgical or outcome fallback is needed');
        return '{"name":"Place order","role":"link"}';
      } } : forbidden;
      const result = await runScenario(frozen, { driver, llm, heal: phase === 'repair', reporter, expectTimeoutMs: 5000 });
      assert.equal(result.result.verdict.passed, true, JSON.stringify(result.result));
      assert.equal(server.snapshot().orderCount, 1);
      assert.equal(server.snapshot().complete, true);
      assert.equal(result.result.usage.llmCalls, phase === 'repair' ? 1 : 0);
      if (phase === 'repair') {
        assert.ok(result.healedScenario);
        assert.deepEqual(result.healedScenario.assertions, frozen.assertions);
        frozen = result.healedScenario;
      }
      report.push({ phase, oracle: server.snapshot(), llmCalls: result.result.usage.llmCalls,
        requests: result.result.evidence.logic.requests, verdict: result.result.verdict });
    });
  } finally { await server.close(); }
}

// A small separate fixture controls navigation count and a persistent order defect.
let orderStatus = 200;
let attempts = 0;
let pendingResponse;
const server = createServer((req, res) => {
  if (req.url === '/api/pending') { pendingResponse = res; return; }
  if (req.url === '/api/order') {
    attempts++;
    res.writeHead(orderStatus); res.end('order'); return;
  }
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><title>Network evidence</title>
    <button onclick="fetch('/api/order', {method:'POST'}).then(() => location.href='/done')">Order</button>
    <button onclick="fetch('/api/pending', {method:'POST'})">Pending</button>
    <a href="/popup" target="_blank">Open tab</a>
    <a href="/next">Continue</a>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  await withBrowser(async driver => {
    const result = await runScenario({ name: 'Retain an order beyond the preserved window', steps: [
      { kind: 'goto', url: base },
      { kind: 'click', target: { text: 'Order', role: 'button' }, expect: expectOrder },
      ...Array.from({ length: 5 }, (_, i) => ({ kind: 'goto', url: `${base}/page-${i}` })),
    ], assertions: [order] }, { driver, llm: forbidden, reporter });
    assert.equal(result.result.verdict.passed, true, JSON.stringify(result.result));
    const before = await driver.observe();
    const watermark = before.logic.requests.length;
    // A later step navigates without ordering; the earlier success must not satisfy its expect.
    const stale = await runScenario({ name: 'Require a new order', steps: [
      { kind: 'click', target: { text: 'Continue', role: 'link' }, expect: expectOrder },
    ], assertions: [order] }, { driver, llm: forbidden, reporter, expectTimeoutMs: 0 });
    assert.equal(stale.result.verdict.passed, false);
    assert.equal(stale.result.evidence.execution.actions[0].errorKind, 'post-condition');
    const after = await driver.observe();
    assert.ok(after.logic.requests.length >= watermark);
    assert.deepEqual(after.logic.requests.slice(0, watermark), before.logic.requests);
    assert.equal(after.logic.requests.filter(r => r.method === 'POST').length, 1);
    report.push({ phase: 'preserved-window-and-watermark', watermark, requests: after.logic.requests });
  });
  // New sessions cannot inherit the successful POST, even when MCP reuses request numbers.
  await withBrowser(async driver => {
    const result = await runScenario({ name: 'Fresh run has no order', steps: [{ kind: 'goto', url: base }], assertions: [order] },
      { driver, llm: forbidden, reporter });
    assert.equal(result.result.verdict.passed, false);
    assert.equal(result.result.evidence.logic.requests.some(r => r.method === 'POST'), false);
    report.push({ phase: 'fresh-run', verdict: result.result.verdict });
  });
  await withBrowser(async driver => {
    await driver.goto(base);
    await driver.click({ text: 'Pending', role: 'button' });
    const before = await driver.observe();
    const index = before.logic.requests.findIndex(r => r.url.endsWith('/api/pending'));
    assert.ok(index >= 0);
    assert.equal(before.logic.requests[index].status, 0);
    assert.ok(pendingResponse);
    pendingResponse.writeHead(200); pendingResponse.end('completed');
    let after;
    for (let i = 0; i < 30; i++) {
      after = await driver.observe();
      if (after.logic.requests[index]?.status === 200) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(after.logic.requests[index].status, 200);
    assert.equal(after.logic.requests.filter(r => r.url.endsWith('/api/pending')).length, 1);
    assert.equal(before.logic.requests[index].status, 0);
    const result = await runScenario({ name: 'Page-local request IDs', steps: [
      { kind: 'click', target: { text: 'Order', role: 'button' }, expect: expectOrder },
      { kind: 'click', target: { text: 'Open tab', role: 'link' }, expect: { url: '/popup' } },
      { kind: 'click', target: { text: 'Order', role: 'button' }, expect: expectOrder },
    ], assertions: [order] }, { driver, llm: forbidden, reporter });
    assert.equal(result.result.verdict.passed, true, JSON.stringify(result.result));
    assert.equal(result.result.evidence.logic.requests.filter(r => r.url === `${base}/api/order`).length, 2);
    report.push({ phase: 'pending-completion-and-popup', requests: result.result.evidence.logic.requests });
  });
  orderStatus = 500;
  await withBrowser(async driver => {
    let healCalls = 0;
    const events = [];
    const startAttempts = attempts;
    const result = await runScenario({ name: 'Order must return 200', steps: [
      { kind: 'goto', url: base }, { kind: 'click', target: { text: 'Order', role: 'button' } },
      { kind: 'waitFor', until: { url: '/done' } },
    ], assertions: [order] }, { driver, heal: true, reporter, maxSteps: 3,
      trace: { emit: event => events.push(event) },
      llm: { id: 'scripted-outcome', async complete() {
        healCalls++;
        assert.ok(healCalls <= 3, 'Only click, done, and assertion proposal are expected');
        return healCalls === 1 ? '{"action":"click","text":"Order","role":"button"}' : healCalls === 2 ? '{"action":"done"}' : '[]';
      } },
    });
    assert.equal(result.result.verdict.passed, false);
    assert.equal(result.healedScenario, undefined);
    assert.equal(attempts - startAttempts, 2);
    assert.deepEqual(result.result.verdict.results[0].statuses, [500]);
    assert.equal(result.result.evidence.logic.requests.filter(r => r.method === 'POST').length, 1,
      'Outcome heal must include only its own request, not the earlier failed attempt');
    assert.ok(events.some(e => e.kind === 'assertion' && e.phase === 'replay' && e.payload.statuses?.includes(500)));
    report.push({ phase: 'persistent-500-with-heal', healCalls, requests: result.result.evidence.logic.requests, verdict: result.result.verdict });
  });
  assert.equal(calls, 0);
  console.log(JSON.stringify(report, null, 2));
  if (process.env.CAIRN_NETWORK_REPORT) await writeFile(process.env.CAIRN_NETWORK_REPORT, JSON.stringify(report, null, 2));
} finally {
  pendingResponse?.end();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
