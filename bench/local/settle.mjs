// #175: real Chrome readiness, polling exclusions and deterministic replay; no hosted model.
// npm run build -w cairn-engine && node bench/local/settle.mjs [--out report.json]
// Add --baseline-engine /absolute/path/to/old/dist/index.js to reproduce the original defects.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const value = flag => {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `${flag} requires a path`);
  return resolve(args[index + 1]);
};
const baselinePath = value('--baseline-engine');
const out = value('--out');
assert.equal(args.length, (baselinePath ? 2 : 0) + (out ? 2 : 0), 'Unknown arguments');
if (out) {
  await access(out).then(() => { throw new Error(`Report already exists: ${out}`); }, error => {
    assert.equal(error.code, 'ENOENT');
  });
  await mkdir(dirname(out), { recursive: true });
}
const engines = [];
if (baselinePath) engines.push({ name: 'baseline', api: await import(pathToFileURL(baselinePath)) });
engines.push({ name: 'patched', api: await import('../../packages/harness/dist/index.js') });
const mcp = process.env.CAIRN_MCP_ENTRY;
const flags = ['--isolated', '--headless', '--no-page-id-routing', '--no-usage-statistics'];
const transport = mcp ? { command: process.execPath, args: [mcp, ...flags] }
  : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] };
const settle = { idleMs: 400, timeoutMs: 2200, pollMs: 40 };
const html = readFileSync(new URL('../../packages/harness/test/fixtures/probe/settle.html', import.meta.url), 'utf8');
const report = [];
let modelCalls = 0;
const forbidden = { id: 'no-model', async complete() { modelCalls++; throw new Error('Unexpected model call'); } };

async function fixture(mode, autoData = false) {
  const state = { dataCount: 0, pollCount: 0, commitCount: 0 };
  const timers = new Set();
  const pendingData = new Set();
  const later = (fn, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
  };
  const sendData = res => { pendingData.delete(res); res.end('Loaded content'); };
  const server = createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.url === '/api/data') {
      state.dataCount++;
      pendingData.add(res);
      if (autoData) later(() => sendData(res), 800);
      return;
    }
    if (req.url === '/api/poll' || req.url === '/api/poll/failing') {
      state.pollCount++;
      // Failed excluded traffic must remain ordinary assertion evidence.
      const status = req.url === '/api/poll/failing' ? 503 : 200;
      later(() => { res.writeHead(status); res.end('poll'); }, 120);
      return;
    }
    if (req.url === '/api/commit' && req.method === 'POST') {
      state.commitCount++;
      res.end('Committed');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    origin: `http://127.0.0.1:${server.address().port}/?mode=${mode}`,
    snapshot: () => ({ ...state }),
    releaseData: () => { for (const res of pendingData) sendData(res); },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const res of pendingData) res.end();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function withBrowser(engine, mode, options, run, autoData = false) {
  const server = await fixture(mode, autoData);
  const driver = new engine.api.ChromeDevToolsDriver({ ...transport, settle: options });
  try { return await run(driver, server); }
  finally { await driver.close(); await server.close(); }
}

async function measuredSettle(driver, options) {
  const started = performance.now();
  await driver.settle(options);
  return Math.round(performance.now() - started);
}

for (const engine of engines) {
  await withBrowser(engine, 'skeleton', settle, async (driver, server) => {
    await driver.goto(server.origin);
    assert.equal(server.snapshot().dataCount, 1, 'The page starts one slow fetch');
    // Hold it past the idle window: counting new requests cannot distinguish pending from idle.
    const release = setTimeout(() => server.releaseData(), 1500);
    try {
      const elapsedMs = await measuredSettle(driver, { ...settle, timeoutMs: 6000 });
      const evidence = await driver.observe();
      const request = evidence.logic.requests.find(r => r.url.endsWith('/api/data'));
      assert.ok(request);
      if (engine.name === 'baseline') {
        assert.equal(request.status, 0, 'The original settle returns while the single fetch is pending');
        assert.ok(elapsedMs < 1500, `Baseline unexpectedly waited for completion: ${elapsedMs}ms`);
      } else {
        assert.equal(request.status, 200);
        assert.ok(elapsedMs >= 1500 + 650 + settle.idleMs, 'Deferred rendering gets its own quiet window');
        const after = await driver.snapshot();
        assert.ok(after.some(row => row.name === 'Loaded content'));
        assert.ok(!after.some(row => row.name === 'Loading data'));
      }
      report.push({ engine: engine.name, phase: 'single-fetch-skeleton', elapsedMs, request, oracle: server.snapshot() });
    } finally { clearTimeout(release); }
  });

  for (const ignored of [false, true]) {
    const options = { ...settle, ...(ignored ? { ignoreRequests: ['/api/poll'] } : {}) };
    await withBrowser(engine, 'polling', options, async (driver, server) => {
      await driver.goto(server.origin);
      const elapsedMs = await measuredSettle(driver, options);
      const evidence = await driver.observe();
      const requests = evidence.logic.requests.filter(r => r.url.includes('/api/poll'));
      assert.ok(server.snapshot().pollCount >= 4, 'Polling remains active during settle');
      assert.ok(requests.some(r => r.status === 503), 'Excluded failures remain in evidence');
      if (!ignored || engine.name === 'baseline') {
        assert.ok(elapsedMs >= settle.timeoutMs, `Continuous polling must reach the cap: ${elapsedMs}ms`);
      } else {
        assert.ok(elapsedMs < settle.timeoutMs - settle.idleMs, `Declared background polling should not burn the cap: ${elapsedMs}ms`);
        // No extra adapter or benign rule: the built-in guard sees exactly the driver's evidence.
        const result = await engine.api.runScenario({ name: 'Excluded polling failures remain failures', steps: [],
          assertions: [{ kind: 'no-failed-requests' }] }, { driver, llm: forbidden, reporter: { async emit() {} } });
        assert.equal(result.result.verdict.passed, false);
        assert.equal(result.result.verdict.results[0].passed, false);
        assert.ok(result.result.evidence.logic.requests.some(r => r.url.endsWith('/api/poll/failing') && r.status === 503));
        assert.equal(result.result.usage.llmCalls, 0);
      }
      report.push({ engine: engine.name, phase: ignored ? 'excluded-polling' : 'ordinary-polling', elapsedMs,
        requestCount: requests.length, failures: requests.filter(r => r.status === 503).length, oracle: server.snapshot() });
    });
  }

  await withBrowser(engine, 'mutating', settle, async (driver, server) => {
    await driver.goto(server.origin);
    const elapsedMs = await measuredSettle(driver, settle);
    if (engine.name === 'baseline') assert.ok(elapsedMs < settle.timeoutMs - settle.idleMs);
    else assert.ok(elapsedMs >= settle.timeoutMs, `Continuous DOM mutation must reach the cap: ${elapsedMs}ms`);
    const rows = await driver.snapshot();
    const counter = rows.find(row => /^Counter [1-9]\d*$/.test(row.name));
    assert.ok(counter, 'The real page continued to mutate');
    report.push({ engine: engine.name, phase: 'continuous-dom', elapsedMs, counter: counter.name });
  });

  if (engine.name === 'patched') await withBrowser(engine, 'skeleton', settle, async (driver, server) => {
    const result = await engine.api.runScenario({ name: 'Load and commit the rendered content', steps: [
      { kind: 'goto', url: server.origin },
      { kind: 'waitFor', until: { text: 'Loaded content' }, timeoutMs: 4000 },
      { kind: 'click', target: { text: 'Commit', role: 'button' } },
    ], assertions: [
      { kind: 'request-status', urlIncludes: '/api/commit', method: 'POST', status: 200, origin: 'user' },
      { kind: 'no-failed-requests' },
    ] }, { driver, llm: forbidden, reporter: { async emit() {} } });
    assert.equal(result.result.verdict.passed, true, JSON.stringify(result.result));
    assert.equal(result.result.usage.llmCalls, 0);
    assert.equal(server.snapshot().commitCount, 1, 'Replay commits exactly once');
    const rows = await driver.snapshot();
    assert.ok(rows.some(row => row.name === 'Committed'), 'Deferred post-submit rendering is visible');
    report.push({ engine: engine.name, phase: 'replay', llmCalls: result.result.usage.llmCalls,
      oracle: server.snapshot(), verdict: result.result.verdict });
  }, true);
}
assert.equal(modelCalls, 0);
console.log(JSON.stringify(report, null, 2));
if (out) await writeFile(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
