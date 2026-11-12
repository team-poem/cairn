// Real Chrome/MCP regression for #341. The original click finishes during a scripted repair decision.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ChromeDevToolsDriver, runScenario } from '../packages/harness/dist/index.js';

let openRequests = 0;
let continuations = 0;
let pending;
const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (req.url === '/api/open' && req.method === 'POST') {
    openRequests++;
    if (pending) { res.writeHead(409); res.end('Duplicate click'); return; }
    pending = res;
    return;
  }
  if (req.url === '/complete') continuations++;
  const body = req.url === '/start'
    ? `<button onclick="fetch('/api/open', {method:'POST'}).then(() => location.href='/arrived')">Open</button>`
    : req.url === '/arrived' ? '<h1>Arrived</h1><a href="/complete">Continue</a>' : '<h1>Complete</h1>';
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><title>Late arrival</title><body>${body}</body>`);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;
const flags = ['--isolated', '--headless', '--no-page-id-routing', '--no-usage-statistics'];
const transport = process.env.CAIRN_MCP_ENTRY
  ? { command: process.execPath, args: [process.env.CAIRN_MCP_ENTRY, ...flags] }
  : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] };
const driver = new ChromeDevToolsDriver({ ...transport, timeoutMs: 10_000, connectTimeoutMs: 30_000,
  settle: { timeoutMs: 200, idleMs: 50, pollMs: 25 } });
const steps = [
  { kind: 'goto', url: `${base}/start` },
  { kind: 'click', target: { text: 'Open', role: 'button' }, intent: 'Open the detail page', expect: { url: '/arrived' } },
  { kind: 'click', target: { text: 'Continue', role: 'link' }, expect: { url: '/complete' } },
];
let modelCalls = 0;
const progress = [];
const events = [];
try {
  const out = await runScenario({ name: 'Original click arrives during declined repair', steps,
    assertions: [{ kind: 'navigated', to: `${base}/complete` }] }, {
    driver, heal: true, expectTimeoutMs: 0, reporter: { async emit() {} },
    budget: { maxModelCalls: 1, timeoutMs: 60_000 },
    onStep: step => progress.push(step), trace: { emit: event => events.push(event) },
    llm: { id: 'scripted-declined-repair', async complete() {
      modelCalls++;
      assert.equal(modelCalls, 1, 'No additional repair or outcome discovery is needed');
      assert.ok(pending, 'The original click must have started its request');
      assert.equal((await driver.observe()).execution.finalUrl, `${base}/start`);
      // Let the browser finish the original action while the repair decision is still pending.
      pending.writeHead(200);
      pending.end('ready');
      const deadline = Date.now() + 10_000;
      while ((await driver.observe()).execution.finalUrl !== `${base}/arrived`) {
        assert.ok(Date.now() < deadline, 'The original action must reach its destination');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return '{"action":"done"}';
    } },
  });
  assert.equal(out.result.verdict.passed, true, JSON.stringify(out.result));
  assert.deepEqual(out.result.evidence.execution.actions, steps.map(step => ({ step, ok: true })));
  assert.equal(openRequests, 1, 'The original click must not be repeated');
  assert.equal(continuations, 1, 'Replay must continue to the next step');
  assert.equal(modelCalls, 1);
  assert.equal(out.result.usage.llmCalls, 1);
  assert.equal(out.healedScenario, undefined);
  assert.equal(progress[1].ok, true);
  assert.equal(progress[1].skipped, undefined);
  assert.equal(events.filter(event => event.kind === 'heal').length, 0);
  console.log('late arrival: continued, 1 original click, 1 model call, no replacement or heal event');
} finally {
  try { await driver.close(); } finally {
    pending?.end();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
