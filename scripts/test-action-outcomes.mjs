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
    <button id="notify">Show alert</button><button id="inch">Add inch</button><input aria-label="Length" id="length">
    <button aria-label="Decorated button" style="padding:0"><span id="label" style="display:block;padding:8px">Label</span></button>
    <button aria-label="Outer button" style="padding:0"><span role="button" id="nested" style="display:block;padding:8px">Inner</span></button>
    <button id="owner" aria-label="Parent button" style="padding:0"><span id="stopped" style="display:block;padding:8px">Own click</span></button>
    <output id="qty">Quantity 0</output>
    <script>
      window.inputs = [];
      window.muteStates = [];
      const lengthField = document.querySelector('#length');
      lengthField.value = '0 "inch"';
      document.querySelector('#stopped').addEventListener('click', e => { inputs.push('stopped'); e.stopPropagation(); });
      document.querySelector('#owner').addEventListener('click', () => inputs.push('wrong-parent'));
      document.addEventListener('click', e => {
        inputs.push(e.target.id);
        if (e.target.id === 'inch') lengthField.value = inputs.length + ' "inch"';
        if (e.target.id === 'notify') {
          alert('Information');
          document.querySelector('#qty').textContent = 'Alert dismissed';
        }
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
    const limit = { alert: 1, quoted: 2, child: 4, nested: 2, stopped: 2, missing: 2, policy: 1 }[which];
    if (limit && turn > limit) return '{"action":"done"}';
    if (which === 'missing' && turn === 1)
      return JSON.stringify({ action:'type', role:'textbox', text:'Nonexistent field', value:'test' });
    if (which === 'quantity' && turn > 3 || which === 'recover' && turn > 3 || which === 'toggle' && turn > 2 ||
        (which === 'baseline' || which === 'measured') && turn > 1) return '{"action":"done"}';
    const focus = { alert:'Show alert', quoted:'Add inch', child:'Decorated button', nested:'Outer button', stopped:'Parent button' }[which];
    const [role, text] = focus ? ['button', focus] : which === 'toggle' ? ['button', 'Mute'] : which === 'quantity' ? ['button', 'Add one']
      : which === 'recover' && turn === 3 ? ['link', 'Open Alpha'] : ['heading', 'Alpha'];
    return JSON.stringify({ action: 'click', role, text });
  } };
  counts = {};
  driverCounts = {};
  const result = await (mode === 'discover' ? discover : explore)('Inspect Alpha', {
    driver, llm, baseUrl: url, maxSteps: 7,
    ...(which === 'policy' && { policy: { vet: () => ({ ok:true }) } }),
    ...(which !== 'baseline' ? { actionOutcomes: { maxRepeats: ['toggle', 'quoted', 'child', 'nested', 'stopped'].includes(which) ? 1 : 2, recoveryTurns: 2,
      ...(which === 'quoted' && { scope: rows => rows.filter(r => r.role === 'textbox' || r.name === 'Add inch') }),
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
  const expected = { alert:['notify'], quoted:['inch','inch'], child:['label'], nested:['nested','nested'], stopped:['stopped','stopped'],
    toggle:['mute','mute'], repeat:['inert','inert'], quantity:['add','add','add'], recover:['inert','inert','open'] }[which] ?? ['inert'];
  assert.deepEqual(clicks, expected, `${mode}/${which}: actual clicks`);
  assert.equal(toolCounts.click, clicks.length, 'Refused clicks must not reach the MCP input tool');
  assert.equal(result.steps.filter(s => s.kind === 'click').length, clicks.length, 'Recorded clicks are retained');
  const blocked = which === 'repeat' || which === 'child';
  assert.equal(result.truncated === true, blocked);
  assert.equal(result.truncationReason, blocked ? 'action-no-progress' : undefined);
  if (which === 'alert') {
    assert.equal(toolCounts.handle_dialog, 1);
    assert.deepEqual(clickStatuses, ['observed-change']);
  }
  if (which === 'quoted') assert.deepEqual(clickStatuses, ['observed-change','observed-change']);
  if (which === 'missing') {
    assert.equal(toolCounts.fill ?? 0, 0, 'A failed lookup must not send a fill');
    assert.equal(seen.length, 3, 'The loop must take a fresh decision after a pre-input failure');
    assert.equal(result.steps.filter(s => s.kind === 'type').length, 0);
  }
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
  client.callTool = async (request, ...args) => {
    const sample = counts;
    if (sample) {
      sample[request.name] = (sample[request.name] ?? 0) + 1;
      if (request.name === 'evaluate_script' && request.arguments.function.includes('cairn.click-outcome.v1'))
        sample.outcomeProbes = (sample.outcomeProbes ?? 0) + 1;
    }
    const result = await callTool(request, ...args);
    if (sample && request.name === 'click' && result.isError) sample.rejectedClicks = (sample.rejectedClicks ?? 0) + 1;
    return result;
  };
  for (const mode of ['discover', 'explore']) {
    let baseline;
    for (const which of ['baseline', 'measured', 'repeat', 'recover', 'quantity', 'toggle', 'alert', 'quoted', 'child', 'nested', 'stopped', 'missing', 'policy']) {
      const sample = await run(mode, which);
      if (which === 'baseline') baseline = sample;
      if (which === 'measured') {
        assert.equal(sample.decisions, baseline.decisions);
        assert.equal(sample.driverReads.snapshot, baseline.driverReads.snapshot);
        assert.equal(sample.toolCounts.take_snapshot, baseline.toolCounts.take_snapshot);
        assert.equal(baseline.toolCounts.outcomeProbes ?? 0, 0);
        assert.equal(sample.toolCounts.outcomeProbes, 2);
        assert.equal(sample.driverReads.observe - baseline.driverReads.observe, 2);
      }
      if (which === 'policy') {
        assert.equal(sample.decisions, baseline.decisions);
        assert.equal(sample.driverReads.observe - baseline.driverReads.observe, mode === 'discover' ? 3 : 2);
      }
      console.log(JSON.stringify(sample));
    }
  }
} finally {
  try { await driver.close(); } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
