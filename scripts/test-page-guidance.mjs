// Real Chrome/MCP contract fixture with scripted decisions; no model account required.
// Build first. CAIRN_MCP_ENTRY may select an installed chrome-devtools-mcp@1.8.0.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ChromeDevToolsDriver, discover, runScenario } from '../packages/harness/dist/index.js';

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
  const seen = [];
  const scenario = await discover('Save order', { driver, llm, baseUrl, maxSteps: 4,
    pageGuidance(request) {
      seen.push({ url: request.url, observationId: request.observationId });
      return request.url.endsWith('/done') ? 'The order was saved.' : 'Use Save order to persist the order.';
    },
  });
  assert.notEqual(scenario.truncated, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, `${baseUrl}/`);
  assert.equal(seen[1].url, `${baseUrl}/done`);
  assert.notEqual(seen[0].observationId, seen[1].observationId);
  assert.equal(scenario.steps.filter(step => step.kind === 'click').length, 1);
  const replay = await runScenario(scenario, { driver, llm: forbidden, reporter: { async emit() {} } });
  assert.equal(replay.result.verdict.passed, true);
  assert.equal(replayModelCalls, 0);
  console.log(JSON.stringify({ guidedObservations: seen.length, modelCalls: calls,
    replayPassed: true, replayModelCalls }, null, 2));
} finally {
  await driver.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
