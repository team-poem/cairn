// Real Chrome/MCP + a local synthetic flow. Scripted decisions; no model account required.
// Build first, then npm run test:selection. CAIRN_MCP_ENTRY may select installed MCP 1.8.0.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ChromeDevToolsDriver, discover, runScenario, startTrace } from '../packages/harness/dist/index.js';

const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(req.url === '/done'
    ? '<!doctype html><title>Done</title><h1>Order saved</h1>'
    : `<!doctype html><title>Selection fixture</title>
      <style>button{font-size:10px;margin:2px}section{display:grid;grid-template-columns:repeat(8,100px)}</style>
      <button onclick="location.href='/done'">Save order</button><button>HOST_PRIVATE_DROP</button>
      <section>${Array.from({ length: 72 }, (_, i) => `<button>Option ${i}</button>`).join('')}</section>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const flags = ['--isolated', '--headless', '--no-page-id-routing', '--no-usage-statistics'];
const options = process.env.CAIRN_MCP_ENTRY
  ? { command: process.execPath, args: [process.env.CAIRN_MCP_ENTRY, ...flags] }
  : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] };
const report = [];
let frozen;
try {
  for (const mode of ['off', 'on', 'throwing']) {
    const driver = new ChromeDevToolsDriver(options);
    const events = [];
    let decisions = 0;
    let calls = 0;
    let snapshots = 0;
    const snapshot = driver.snapshot.bind(driver);
    driver.snapshot = async (...args) => { snapshots++; return snapshot(...args); };
    const llm = { id: 'scripted-selection-fixture', async complete(prompt) {
      calls++;
      if (!prompt.includes('What is the single next action?')) return '[]';
      decisions++;
      assert.ok(!prompt.includes('HOST_PRIVATE_DROP'));
      if (decisions > 1) return '{"action":"done"}';
      const line = prompt.split('\n').find(row => row.includes('ref=') && row.includes('Save order') && row.includes('button'));
      const ref = line?.match(/ref="([^"]+)"/)?.[1];
      assert.ok(ref, 'Fixture must exercise a real exact-node reference');
      return JSON.stringify({ action: 'click', ref });
    } };
    const trace = mode === 'off' ? undefined : startTrace({ emit(event) {
      if (event.kind !== 'selection') return;
      events.push(event);
      if (mode === 'throwing') throw new Error('fixture sink failure');
    } }, 'fixture').scope('selection');
    try {
      const scenario = await discover('Save order', { driver, llm, baseUrl, maxSteps: 3, trace,
        perceive: rows => rows.filter(row => !row.name.includes('HOST_PRIVATE_DROP')) });
      assert.notEqual(scenario.truncated, true);
      assert.equal(scenario.steps.filter(step => step.kind === 'click').length, 1);
      assert.equal((await driver.observe()).execution.finalUrl, `${baseUrl}/done`);
      assert.equal(decisions, 2);
      assert.equal(snapshots, 2);
      if (mode !== 'off') {
        assert.equal(events.length, 2);
        const first = events[0].payload;
        assert.equal(first.stage, 'prepared');
        assert.ok(first.raw.count > first.perceived.count);
        assert.equal(first.selected.count, 60);
        assert.ok(first.capOmitted > 0);
        assert.equal(first.eligible.count, first.selected.count + first.capOmitted);
        const json = JSON.stringify(events.map(e => e.payload));
        for (const forbidden of [baseUrl, 'HOST_PRIVATE_DROP', 'Save order', 'Option ', 'Order saved']) {
          assert.ok(!json.includes(forbidden));
        }
        assert.notEqual(events[0].payload.decisionId, events[1].payload.decisionId);
      }
      if (frozen) assert.deepEqual(scenario, frozen, 'Tracing must not change the frozen test');
      frozen = scenario;
      report.push({ mode, decisions, calls, snapshots, selectionEvents: events.length });
    } finally { await driver.close(); }
  }
  const driver = new ChromeDevToolsDriver(options);
  try {
    let modelCalls = 0;
    const events = [];
    const result = await runScenario(frozen, { driver,
      llm: { id: 'forbidden', async complete() { modelCalls++; throw new Error('Healthy replay called a model'); } },
      trace: { emit: event => events.push(event) }, reporter: { async emit() {} } });
    assert.equal(result.result.verdict.passed, true);
    assert.equal(modelCalls, 0);
    assert.equal(events.filter(e => e.kind === 'selection').length, 0);
    report.push({ mode: 'replay', passed: true, modelCalls, selectionEvents: 0 });
  } finally { await driver.close(); }
  assert.equal(report[0].calls, report[1].calls);
  assert.equal(report[0].calls, report[2].calls);
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
