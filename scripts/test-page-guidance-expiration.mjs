// Real Chrome/MCP contract fixture; scripted decisions, not a model-quality benchmark.
// Run after npm run build. CAIRN_MCP_ENTRY may select an installed MCP 1.8.0 CLI.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ChromeDevToolsDriver, discover, explore, startTrace } from '../packages/harness/dist/index.js';

const cases = new Map();
const ackTimeoutMs = 10_000;
function waitForTick(state, tick) {
  if (state.seen >= tick) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const waiter = { tick, resolve: () => { clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => {
      state.waiters.delete(waiter);
      reject(new Error(`Browser did not acknowledge countdown tick ${tick} within ${ackTimeoutMs}ms`));
    }, ackTimeoutMs);
    state.waiters.add(waiter);
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const state = cases.get(url.searchParams.get('case'));
  if (!state) { res.writeHead(404); res.end(); return; }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    state.clients.add(res);
    res.write(`data: ${state.tick}\n\n`);
    res.on('close', () => state.clients.delete(res));
    return;
  }
  if (url.pathname === '/seen') {
    state.seen = Math.max(state.seen, Number(url.searchParams.get('tick')));
    for (const waiter of state.waiters) {
      if (state.seen >= waiter.tick) { state.waiters.delete(waiter); waiter.resolve(); }
    }
    res.writeHead(204); res.end(); return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/done') {
    state.completed++;
    res.end('<!doctype html><title>Done</title><h1>Flow completed</h1>');
    return;
  }
  res.end(`<!doctype html><title>Countdown fixture</title>
    <h1>Countdown fixture</h1>
    <button id="countdown" disabled>Refresh in 60 seconds</button>
    <button id="continue">Continue</button>
    <script>
      const caseId = new URLSearchParams(location.search).get('case');
      document.getElementById('continue').onclick = () => {
        location.href = '/done?case=' + encodeURIComponent(caseId);
      };
      const events = new EventSource('/events?case=' + encodeURIComponent(caseId));
      events.onmessage = async event => {
        const tick = Number(event.data);
        document.getElementById('countdown').textContent = 'Refresh in ' + (60 - tick) + ' seconds';
        await new Promise(resolve => requestAnimationFrame(resolve));
        await fetch('/seen?case=' + encodeURIComponent(caseId) + '&tick=' + tick, { method: 'POST' });
      };
    </script>`);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const flags = ['--isolated', '--headless', '--no-page-id-routing', '--no-usage-statistics'];
const chrome = new ChromeDevToolsDriver({
  ...(process.env.CAIRN_MCP_ENTRY
    ? { command: process.execPath, args: [process.env.CAIRN_MCP_ENTRY, ...flags] }
    : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] }),
  settle: { ignoreRequests: ['/events'] },
});

async function runCase(mode, changes) {
  const id = `${mode}-${changes}`;
  const state = { tick: 0, seen: -1, clients: new Set(), waiters: new Set(), completed: 0 };
  cases.set(id, state);
  let clicks = 0;
  let decisions = 0;
  let proposals = 0;
  let guidanceCalls = 0;
  const events = [];
  // Adapt only public Driver methods: retain real AX facts, but exercise the ref-free gate.
  const driver = new Proxy(chrome, { get(target, key) {
    if (key === 'locateRef') return undefined;
    if (key === 'snapshot') return async () => (await target.snapshot({ perception: true }))
      .map(({ ref, ...element }) => element);
    if (key === 'click') return async (...args) => { clicks++; return target.click(...args); };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const llm = { id: 'scripted-guidance-expiration-fixture', async complete(prompt) {
    if (!prompt.includes('What is the single next action?')) {
      proposals++;
      assert.equal(mode, 'discover', 'Exploration must not request assertion proposals');
      return '[]';
    }
    decisions++;
    assert.ok(decisions <= 3, 'No fourth decision should be needed in either fixture');
    if (state.completed > 0) {
      assert.match(prompt, /Flow completed/, 'Completion must use a fresh destination observation');
      return '{"action":"done"}';
    }
    await waitForTick(state, state.tick);
    assert.match(prompt, new RegExp(`Refresh in ${60 - state.tick} seconds`),
      'The decision must see the current real countdown before it changes');
    if (changes === 'continuous' || decisions === 1) {
      const tick = ++state.tick;
      const seen = waitForTick(state, tick);
      for (const client of state.clients) client.write(`data: ${tick}\n\n`);
      // Wait for the actual app to update its DOM before the engine validates this decision.
      await seen;
    }
    return '{"action":"click","text":"Continue"}';
  } };
  const options = {
    driver, llm, baseUrl: `${baseUrl}/?case=${id}`, maxSteps: 8,
    trace: startTrace({ emit: event => events.push(event) }, id).scope(id),
    pageGuidance() { guidanceCalls++; return 'Continue leads to the completed flow.'; },
  };
  const result = await (mode === 'discover' ? discover : explore)('Complete the flow', options);
  const expired = events.filter(event => event.kind === 'gate' && event.payload.gate === 'page-guidance'
    && event.payload.reason === 'page guidance expired: the page elements changed after the guided observation');
  const terminal = events.filter(event => event.kind === 'gate' && event.payload.code === 'page-guidance-expired');
  assert.equal(decisions, 3);
  assert.equal(proposals, mode === 'discover' ? 1 : 0);
  assert.equal(guidanceCalls, 3);
  if (changes === 'continuous') {
    assert.equal(clicks, 0, 'Expired decisions must never reach the browser click method');
    assert.equal(state.completed, 0, 'The application must not navigate to completion');
    assert.equal(result.steps.filter(step => step.kind === 'click').length, 0);
    assert.equal(result.truncated, true);
    assert.equal(result.truncationReason, 'page-guidance-expired');
    assert.equal(expired.length, 3);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].payload.expirations, 3);
  } else {
    assert.equal(clicks, 1);
    assert.equal(state.completed, 1);
    assert.equal(result.steps.filter(step => step.kind === 'click').length, 1);
    assert.notEqual(result.truncated, true);
    assert.equal(result.truncationReason, undefined);
    assert.equal(expired.length, 1);
    assert.equal(terminal.length, 0);
  }
  return { mode, changes, decisions, proposals, clicks, expirations: expired.length,
    truncated: result.truncated === true, reason: result.truncationReason ?? null };
}

try {
  const results = [];
  for (const mode of ['discover', 'explore']) {
    for (const changes of ['continuous', 'transient']) results.push(await runCase(mode, changes));
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  try { await chrome.close(); } finally {
    for (const state of cases.values()) for (const client of state.clients) client.end();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
