// Real Chrome/MCP contract fixture with scripted decisions; no model account required.
// Build first. CAIRN_MCP_ENTRY may select an installed chrome-devtools-mcp@1.8.0.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ChromeDevToolsDriver, discover, runScenario, runWorkflow } from '../packages/harness/dist/index.js';

const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(req.url === '/done'
    ? '<!doctype html><title>Done</title><h1>Order saved</h1>'
    : `<!doctype html><title>Orders</title><button onclick="location.href='/done'">Save order</button>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const flags = ['--isolated', '--headless', '--no-page-id-routing', '--no-usage-statistics'];
const driver = new ChromeDevToolsDriver(process.env.CAIRN_MCP_ENTRY
  ? { command: process.execPath, args: [process.env.CAIRN_MCP_ENTRY, ...flags] }
  : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] });
let calls = 0;
let decisions = 0;
const llm = { id: 'scripted-workflow-fixture', async complete(prompt) {
  calls++;
  if (!prompt.includes('What is the single next action?')) return '[]';
  if (++decisions > 1) return '{"action":"done"}';
  const row = prompt.split('\n').find(line => line.includes('Save order') && line.includes('ref='));
  const ref = row?.match(/ref="([^"]+)"/)?.[1];
  assert.ok(ref, 'The real Chrome fixture must issue an exact node reference');
  return JSON.stringify({ action: 'click', ref });
} };
let replayModelCalls = 0;
const forbidden = { id: 'no-replay-model', async complete() {
  replayModelCalls++;
  throw new Error('Mechanical replay called a model');
} };
try {
  const outcome = await runWorkflow({ budget: { maxModelCalls: 3, timeoutMs: 60_000 } }, async workflow => {
    await workflow.borrow('prepare').driver(driver).goto(baseUrl);
    const scenario = await discover('Save order', { driver, llm, baseUrl, maxSteps: 4, workflow: workflow.borrow('main') });
    assert.notEqual(scenario.truncated, true);
    const replay = await runScenario(scenario, { driver, llm: forbidden, reporter: { async emit() {} },
      workflow: workflow.borrow('verify') });
    return replay.result.verdict.passed;
  });
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.value, true);
  assert.equal(outcome.modelCalls, 3);
  assert.equal(replayModelCalls, 0);
  assert.deepEqual(outcome.participants.map(p => [p.name, p.modelCalls]), [['prepare', 0], ['main', 3], ['verify', 0]]);
  let admitted = 0;
  const exhaustion = await runWorkflow({ budget: { maxModelCalls: 1, timeoutMs: 60_000 } }, async workflow => {
    const client = workflow.borrow('host').llm({ id: 'host', async complete() { admitted++; return 'ok'; } });
    await client.complete('one');
    return client.complete('two');
  });
  assert.equal(exhaustion.status, 'exhausted');
  assert.equal(admitted, 1);
  console.log(JSON.stringify({ status: outcome.status, modelCalls: calls,
    participants: outcome.participants.map(p => ({ name: p.name, modelCalls: p.modelCalls })),
    replayModelCalls, hostExhaustion: exhaustion.status, hostDispatches: admitted }, null, 2));
} finally {
  await driver.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
