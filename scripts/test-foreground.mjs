// Real Chrome/MCP capture -> scripted discovery -> frozen zero-model replay.
// Build first. CAIRN_MCP_ENTRY may point to an installed MCP 1.8.0 CLI.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { ChromeDevToolsDriver, discover, runScenario, startTrace } from '../packages/harness/dist/index.js';

const fixture = await readFile(new URL('../packages/harness/test/fixtures/probe/foreground.html', import.meta.url), 'utf8');
const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(req.url === '/done' ? '<!doctype html><title>Done</title><h1>Saved</h1>' : fixture);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const flags = ['--isolated', '--headless', '--viewport=1280x800', '--no-page-id-routing', '--no-usage-statistics'];
const options = process.env.CAIRN_MCP_ENTRY
  ? { command: process.execPath, args: [process.env.CAIRN_MCP_ENTRY, ...flags] }
  : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] };
const driver = new ChromeDevToolsDriver(options);
try {
  await driver.goto(baseUrl);
  const rows = await driver.snapshot({ perception: true });
  const field = rows.find(row => row.role === 'textbox' && row.name === 'Foreground input');
  assert.equal(field?.inActivePopup, true, 'Real accessibility input must receive foreground membership');
  assert.equal(field?.occluded, false);
  assert.ok(field?.ref, 'Real capture must retain exact-node references');
  const saves = rows.filter(row => row.role === 'button' && row.name === 'Save');
  assert.equal(saves.length, 2);
  assert.equal(saves[0].inActivePopup, undefined);
  assert.equal(saves[1].inActivePopup, true);
  assert.equal((await driver.locateRef(saves[1].ref)).nth, 1, 'Foreground selection must not change persistent duplicate ordinals');

  // A click alone cannot satisfy the flow: an empty or incorrect input must not navigate.
  await driver.click({ text: 'Save', role: 'button', nth: 1 }, saves[1].ref);
  assert.equal((await driver.observe()).execution.finalUrl, `${baseUrl}/`);
  await driver.type({ text: 'Foreground input', role: 'textbox' }, 'wrong');
  await driver.click({ text: 'Save', role: 'button', nth: 1 });
  assert.equal((await driver.observe()).execution.finalUrl, `${baseUrl}/`);

  const events = [];
  let decisions = 0;
  let calls = 0;
  const addressing = [];
  const llm = { id: 'scripted-foreground-fixture', async complete(prompt) {
    calls++;
    if (!prompt.includes('What is the single next action?')) return '[]';
    decisions++;
    if (decisions > 2) return '{"action":"done"}';
    const name = decisions === 1 ? 'Foreground input' : 'Save';
    const role = decisions === 1 ? 'textbox' : 'button';
    const matches = prompt.split('\n').filter(line => line.includes('ref=') && line.includes(name) && line.includes(role));
    if (matches.length) {
      assert.equal(matches.length, 1, `Only the unobstructed ${name} should be offered`);
      const ref = matches[0].match(/ref="([^"]+)"/)?.[1];
      assert.ok(ref);
      addressing.push('ref');
      return JSON.stringify(decisions === 1 ? { action: 'type', ref, value: 'fixture' } : { action: 'click', ref });
    }
    // Native input value rows can make a later capture unguardable. Honor the existing
    // no-reference contract, retaining the full-tree duplicate ordinal rather than inventing a ref.
    assert.ok(!prompt.includes('ref='));
    assert.equal(decisions, 2, 'The initial input must exercise exact addressing');
    assert.ok(prompt.includes('- [button] Save (active popup) (nth=1)'));
    addressing.push('name-role-nth');
    return JSON.stringify({ action: 'click', text: 'Save', role: 'button', nth: 1 });
  } };
  const scenario = await discover('Enter a value and save', { driver, llm, baseUrl, maxSteps: 4,
    trace: startTrace({ emit(event) { if (event.kind === 'selection') events.push(event); } }, 'fixture').scope('foreground') });
  assert.notEqual(scenario.truncated, true);
  assert.equal((await driver.observe()).execution.finalUrl, `${baseUrl}/done`);
  assert.equal(decisions, 3);
  assert.equal(scenario.steps.filter(step => step.kind === 'type').length, 1);
  assert.equal(scenario.steps.find(step => step.kind === 'type').text, 'fixture');
  assert.equal(scenario.steps.filter(step => step.kind === 'click').length, 1);
  assert.ok(events[0].payload.capOmitted > 0, 'Real discovery must exercise the selection cap');
  assert.equal(JSON.stringify(scenario).includes('cairn:'), false, 'Freeze must not persist temporary references');
  const frozen = JSON.parse(JSON.stringify(scenario));
  assert.ok(frozen.assertions.some(assertion => assertion.kind === 'navigated' && assertion.to?.includes('/done')));
  let replayCalls = 0;
  const replay = await runScenario(frozen, { driver, reporter: { async emit() {} },
    llm: { id: 'forbidden', async complete() { replayCalls++; throw new Error('Healthy replay called a model'); } } });
  assert.equal(replay.result.verdict.passed, true);
  assert.equal(replayCalls, 0);
  console.log(JSON.stringify({ candidates: rows.length, decisions, scriptedCalls: calls,
    selected: events[0].payload.selected.count, capOmitted: events[0].payload.capOmitted,
    addressing, exactDuplicateOrdinal: 1, incorrectInputBlocked: true,
    replayPassed: true, replayModelCalls: replayCalls }, null, 2));
} finally {
  await driver.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
