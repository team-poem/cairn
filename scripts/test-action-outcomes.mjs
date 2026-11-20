// Run after npm run build. Scripted model; the DOM and all driver measurements are real.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ChromeDevToolsDriver, discover, explore } from '../packages/harness/dist/index.js';

const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>Action outcomes</title>
    <h1 id="inert">Alpha</h1>
    <a id="open" href="#detail">Open Alpha</a><button id="add">Add one</button><button id="mute" aria-pressed="false">Mute</button>
    <output id="qty">Quantity 0</output>
    <script>
      window.inputs = [];
      window.muteStates = [];
      document.addEventListener('click', e => {
        inputs.push(e.target.id);
        if (e.target.id === 'open') {
          e.preventDefault();
          history.pushState({}, '', '/detail');
          document.getElementById('inert').textContent = 'Detail opened';
        }
        if (e.target.id === 'add') {
          document.getElementById('qty').textContent = 'Quantity ' + inputs.length;
        }
        if (e.target.id === 'mute') {
          const next = e.target.getAttribute('aria-pressed') === 'true' ? 'false' : 'true';
          e.target.setAttribute('aria-pressed', next);
          muteStates.push(next);
        }
      });
    </script>`);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const url = `http://127.0.0.1:${server.address().port}`;
const flags = ['--isolated', '--headless', '--no-page-id-routing', '--no-usage-statistics', '--no-performance-crux'];
const driver = new ChromeDevToolsDriver(process.env.CAIRN_MCP_ENTRY
  ? { command: process.execPath, args: [process.env.CAIRN_MCP_ENTRY, ...flags] }
  : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] });
const call = driver.call.bind(driver);
let counts;
let driverCounts;

async function run(mode, which) {
  const seen = [];
  const clickStatuses = [];
  let assertionCalls = 0;
  const llm = { id: 'scripted-action-outcome', async complete(prompt) {
    if (prompt.includes('Propose the verification assertions.')) { assertionCalls++; return '[]'; }
    const turn = seen.push(prompt);
    if (which === 'quantity' && turn > 3 || which === 'recover' && turn > 3 || which === 'toggle' && turn > 2 ||
        (which === 'baseline' || which === 'measured') && turn > 1) return '{"action":"done"}';
    const [role, text] = which === 'toggle' ? ['button', 'Mute'] : which === 'quantity' ? ['button', 'Add one']
      : which === 'recover' && turn === 3 ? ['link', 'Open Alpha'] : ['heading', 'Alpha'];
    return JSON.stringify({ action: 'click', role, text });
  } };
  counts = {};
  driverCounts = {};
  const result = await (mode === 'discover' ? discover : explore)('Inspect Alpha', {
    driver, llm, baseUrl: url, maxSteps: 7,
    ...(which !== 'baseline' ? { actionOutcomes: { maxRepeats: which === 'toggle' ? 1 : 2, recoveryTurns: 2,
      onOutcome({action, status}) { if (action === 'click') clickStatuses.push(status); },
    } } : {}),
  });
  const toolCounts = counts;
  const driverReads = driverCounts;
  counts = undefined;
  driverCounts = undefined;
  const raw = await call('evaluate_script', { function: '() => window.inputs' }, 'observation');
  const match = raw.match(/```json\s*([\s\S]*?)\s*```/);
  assert.ok(match, 'Expected a JSON array of actual DOM click events');
  const clicks = JSON.parse(match[1]);
  const expected = which === 'toggle' ? ['mute', 'mute'] : which === 'repeat' ? ['inert', 'inert'] : which === 'quantity' ? ['add', 'add', 'add']
    : which === 'recover' ? ['inert', 'inert', 'open'] : ['inert'];
  assert.deepEqual(clicks, expected, `${mode}/${which}: actual clicks`);
  assert.equal(toolCounts.click, clicks.length, 'Refused clicks must not reach the MCP input tool');
  assert.equal(result.steps.filter(s => s.kind === 'click').length, clicks.length, 'Recorded clicks are retained');
  assert.equal(result.truncated === true, which === 'repeat');
  assert.equal(result.truncationReason, which === 'repeat' ? 'action-no-progress' : undefined);
  assert.equal(assertionCalls, mode === 'discover' ? 1 : 0);
  if (which === 'repeat' || which === 'recover') assert.match(seen[1], /no change was observed/i);
  if (which === 'repeat') assert.ok(seen.length <= 4);
  if (which === 'quantity') assert.match(seen[2], /Quantity 2/);
  if (which === 'toggle') {
    const history = await call('evaluate_script', { function: '() => window.muteStates' }, 'observation');
    const states = history.match(/```json\s*([\s\S]*?)\s*```/);
    assert.ok(states, 'Expected the actual aria-pressed transitions');
    assert.deepEqual(JSON.parse(states[1]), ['true', 'false']);
    assert.deepEqual(clickStatuses, ['observed-change', 'observed-change']);
  }
  return { mode, which, decisions: seen.length, clicks, clickStatuses, driverReads, toolCounts };
}

try {
  // Count actual MCP requests past the pre-input veto, not attempts to enter driver.click.
  const client = await driver.ensureConnected();
  for (const method of ['observe', 'snapshot']) {
    const original = driver[method].bind(driver);
    driver[method] = (...args) => {
      if (driverCounts) driverCounts[method] = (driverCounts[method] ?? 0) + 1;
      return original(...args);
    };
  }
  const callTool = client.callTool.bind(client);
  client.callTool = (request, ...args) => {
    if (counts) counts[request.name] = (counts[request.name] ?? 0) + 1;
    return callTool(request, ...args);
  };
  for (const mode of ['discover', 'explore']) {
    for (const which of ['baseline', 'measured', 'repeat', 'recover', 'quantity', 'toggle']) {
      console.log(JSON.stringify(await run(mode, which)));
    }
  }
} finally {
  try { await driver.close(); } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
