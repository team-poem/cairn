// Real MCP accessibility capture, trusted host injection, discovery and zero-model replay.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { ChromeDevToolsDriver, createHostOwnedRootScope, discover, runScenario } from '../packages/harness/dist/index.js';
import { conditionMet, waitForCondition } from '../packages/harness/dist/core/steps.js';
import { renderElements } from '../packages/harness/dist/core/discover/prompt.js';

const fixture = await readFile(new URL('../packages/harness/test/fixtures/probe/host-owned.html', import.meta.url), 'utf8');
const namesFixture = await readFile(new URL('../packages/harness/test/fixtures/probe/host-owned-names.html', import.meta.url), 'utf8');
const selectFixture = await readFile(new URL('../packages/harness/test/fixtures/probe/host-owned-select.html', import.meta.url), 'utf8');
const virtualFixture = await readFile(new URL('../packages/harness/test/fixtures/probe/host-owned-virtual.html', import.meta.url), 'utf8');
const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(req.url === '/done' ? '<!doctype html><title>Done</title><h1>Application saved</h1>'
    : req.url === '/names' ? namesFixture : req.url === '/select' ? selectFixture
    : req.url === '/virtual' ? virtualFixture
    : req.url === '/list' ? '<!doctype html><title>List</title><ul><li>App item</li></ul><button id="list-action" onclick="document.body.dataset.clicked=\'yes\'">List action</button><aside id="host">Host panel</aside>'
    : req.url === '/generated' ? '<!doctype html><title>Generated</title><style>#host::before {content:"Host generated secret"}</style><button onclick="document.body.dataset.clicked=\'yes\'">Application action</button><aside id="host"></aside>'
    : fixture);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const flags = ['--isolated', '--headless', '--viewport=1280x800', '--no-page-id-routing', '--no-usage-statistics'];
const hostOwnedRoots = createHostOwnedRootScope();
const transport = process.env.CAIRN_MCP_ENTRY
    ? { command: process.execPath, args: [process.env.CAIRN_MCP_ENTRY, ...flags] }
    : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] };
const driver = new ChromeDevToolsDriver({ hostOwnedRoots, settle: { idleMs: 50, pollMs: 25, timeoutMs: 500 }, ...transport,
});
const evaluate = source => driver.call('evaluate_script', { function: `() => { ${source} }` });
const inject = async () => evaluate(`
  // Trusted fixture host creates its own node and registers that exact object.
  // Selecting a template here is not a selector-based engine ownership rule.
  const template = document.getElementById('host');
  const root = template.cloneNode(true); template.replaceWith(root);
  (${hostOwnedRoots.registerScript})(root);
  // Keep ordinary list markers present during discovery/freeze/replay too.
  const list = document.createElement('ul');
  const item = document.createElement('li'); item.textContent = 'Application list context';
  list.append(item); document.querySelector('main').append(list);
  document.getElementById('second').onclick = () => { location.href = '/done'; };
  return {};
`);
try {
  const defaultReferenceScopes = [];
  for (const scope of ['none', 'empty']) {
    const subject = scope === 'none' ? new ChromeDevToolsDriver(transport) : driver;
    try {
      for (const path of ['list', 'generated']) {
        await subject.goto(`${baseUrl}/${path}`);
        const rows = await subject.snapshot({ perception: true });
        const action = rows.find(row => row.role === 'button');
        assert.ok(action?.ref, `${scope}/${path}: virtual rows must not disable real-control refs`);
        assert.equal(rows.some(row => ['ListMarker', 'InlineTextBox', 'ignored'].includes(row.role)), false);
        const target = await subject.locateRef(action.ref);
        await subject.click(target, action.ref);
        assert.match(await subject.call('evaluate_script', { function: '() => ({ clicked: document.body.dataset.clicked })' }), /yes/);
      }
      await subject.goto(`${baseUrl}/list`);
      await subject.call('evaluate_script', { function: `() => new Promise(resolve => {
        const frame = document.createElement('iframe');
        frame.srcdoc = ${JSON.stringify('<ul><li>Frame item</li></ul><button onclick="parent.document.body.dataset.frameClicked=\'yes\'">Frame action</button>')};
        frame.onload = () => resolve({}); document.body.append(frame);
      })` });
      const framed = await subject.snapshot({ perception: true });
      assert.ok(framed.some(row => row.name === 'Frame item'));
      const action = framed.find(row => row.role === 'button' && row.name === 'Frame action');
      assert.ok(action?.ref, `${scope}: lists in both documents must preserve frame refs`);
      const target = await subject.locateRef(action.ref);
      await subject.click(target, action.ref);
      assert.match(await subject.call('evaluate_script', { function: '() => ({ clicked: document.body.dataset.frameClicked })' }), /yes/);
      defaultReferenceScopes.push(scope);
    } finally { if (subject !== driver) await subject.close(); }
  }
  const virtualCases = [];
  for (const path of ['list', 'virtual', 'generated']) {
    await driver.goto(`${baseUrl}/${path}`);
    const before = await driver.call('take_snapshot', { verbose: true });
    if (path !== 'generated') assert.match(before, /ListMarker/);
    if (path === 'virtual') assert.match(before, /Host generated secret/);
    // Empty ownership continues to expose the ordinary app and host text.
    assert.ok((await driver.snapshot()).some(row => row.name.includes(path === 'list' ? 'Host panel' : 'Host generated secret')));
    await evaluate(`return (${hostOwnedRoots.registerScript})(document.getElementById('host'));`);
    for (const perception of [false, true]) {
      const sanitized = await driver.snapshot({ perception });
      assert.equal(sanitized.some(row => /Host (?:panel|generated|list|date)|2042/.test(`${row.name} ${row.value ?? ''}`)), false);
      assert.equal(sanitized.some(row => ['ListMarker', 'ignored', 'InlineTextBox'].includes(row.role)), false);
      if (path === 'list') {
        assert.ok(sanitized.some(row => row.name === 'App item'));
        const action = sanitized.find(row => row.role === 'button' && row.name === 'List action');
        assert.ok(action);
        if (perception) {
          assert.ok(action.ref, 'A virtual marker must not disable exact refs for real controls');
          const target = await driver.locateRef(action.ref);
          await driver.click(target, action.ref);
          assert.match(await evaluate('return { clicked: document.body.dataset.clicked };'), /yes/);
        }
      } else if (path === 'virtual') {
        for (const name of ['Application unordered item', 'Application ordered item', 'Application custom item',
          'Application generated content', 'Application summary', 'Application details', 'Application choice',
          'Application date', 'Application number', 'Application range', 'Application progress', 'Application icon',
          'Application color', 'Application file', 'Application editor', 'Application cell', 'Generated button',
          ...(perception ? ['Application meter'] : [])]) {
          assert.ok(sanitized.some(row => row.name === name), `Missing real app node: ${name}`);
        }
      } else assert.ok(sanitized.some(row => row.name === 'Application action'));
    }
    if (path !== 'generated') {
      await driver.click({ selector: '#list-action' });
      assert.match(await evaluate('return { clicked: document.body.dataset.clicked };'), /yes/);
      assert.equal((await driver.locate({ text: 'List action' })).text, 'List action');
    }
    if (path === 'virtual') {
      // The anonymous generated text is not a target, but its real owning control
      // retains the browser-computed accessible name and remains actionable.
      await driver.click({ text: 'Generated button', role: 'button' });
      assert.match(await evaluate('return { clicked: document.body.dataset.generated };'), /yes/);
      // Both roles are reachable; keep the existing tree-order tie-break without
      // allowing virtual rows back into the ownership-aware reachability batch.
      assert.equal((await driver.locate({ text: 'Shared action' })).role, 'link');
    }
    assert.equal(await conditionMet(driver, { text: 'Host generated secret' }), false);
    virtualCases.push(path);
  }
  await driver.goto(baseUrl);
  assert.equal((await driver.snapshot()).filter(row => row.name === 'Save' && row.role === 'button').length, 3);
  await inject();
  const ordinary = await driver.snapshot();
  const rows = await driver.snapshot({ perception: true });
  for (const pool of [ordinary, rows]) {
    assert.equal(pool.some(row => row.name.startsWith('Host')), false);
    assert.equal(pool.filter(row => row.role === 'button' && row.name === 'Save').length, 2);
    assert.ok(pool.some(row => row.name === 'Application control'), 'Page-owned marker must not grant exclusion');
  }
  const saves = rows.filter(row => row.role === 'button' && row.name === 'Save');
  assert.ok(saves[1].ref);
  assert.deepEqual(await driver.locateRef(saves[1].ref), { text: 'Save', role: 'button', index: 1, nth: 1 });
  await driver.type({ text: 'Application input', role: 'textbox' }, 'app value');
  assert.ok((await driver.snapshot({ perception: true })).some(row => row.role === 'textbox' && row.value === 'app value'));
  await driver.type({ text: 'Application input', role: 'textbox' }, '');
  await assert.rejects(driver.click({ selector: '#host-save', text: 'Save', role: 'button', nth: 0 }), /host-owned/);
  assert.equal(await conditionMet(driver, { text: 'Host-only success' }), false);
  await assert.rejects(waitForCondition(driver, { text: 'Host-only success' }, 100), /timed out/);
  await evaluate("document.getElementById('counter').textContent = 'Host count 456'; return {};");
  assert.deepEqual(await driver.snapshot(), ordinary, 'Host-only text churn must not reset semantic progress');
  await evaluate("document.getElementById('host-field').focus(); return {};");
  await assert.rejects(driver.pressKey('Enter'), /Keyboard input/);
  await evaluate("document.getElementById('host').classList.add('overlay'); return {};");
  await assert.rejects(driver.click({ text: 'Save', role: 'button', nth: 1 }), /host-obstructed/);
  await evaluate("document.getElementById('host').classList.remove('overlay'); return {};");
  assert.ok(await driver.screenshot(), 'Screenshots still include the unmodified page');
  await evaluate("return fetch('/host-signal').then(() => { console.warn('fixture host diagnostic'); return {}; });");
  const evidence = await driver.observe();
  assert.ok(evidence.logic.requests.some(request => request.url.includes('/host-signal')));
  assert.ok(evidence.logic.console.some(message => message.text.includes('fixture host diagnostic')));

  // Host instrumentation is explicitly re-registered for each new document, never inferred
  // from a persistent selector. This wrapper models the consumer's injection lifecycle.
  const goto = driver.goto.bind(driver);
  driver.goto = async url => { await goto(url); if (new URL(url).pathname === '/') await inject(); };
  let decisions = 0;
  const llm = { id: 'scripted-host-fixture', async complete(prompt) {
    if (!prompt.includes('What is the single next action?')) return '[]';
    if (++decisions > 1) return '{"action":"done"}';
    assert.equal(prompt.includes('Host-only success'), false);
    const matches = prompt.split('\n').filter(line => line.includes('ref=') && line.includes('[button] Save'));
    assert.equal(matches.length, 2);
    const ref = matches[1].match(/ref="([^"]+)"/)?.[1];
    assert.ok(ref);
    return JSON.stringify({ action: 'click', ref });
  } };
  const scenario = await discover('Click the second application Save button', { driver, llm, baseUrl, maxSteps: 3 });
  assert.notEqual(scenario.truncated, true);
  assert.equal(decisions, 2);
  assert.equal((await driver.observe()).execution.finalUrl, `${baseUrl}/done`);
  assert.equal(scenario.steps.find(step => step.kind === 'click').target.nth, 1);
  assert.equal(JSON.stringify(scenario).includes(hostOwnedRoots.key), false);
  assert.equal(JSON.stringify(scenario).includes('cairn:'), false);
  let replayCalls = 0;
  const replay = await runScenario(JSON.parse(JSON.stringify(scenario)), { driver, reporter: { async emit() {} },
    llm: { id: 'forbidden', async complete() { replayCalls++; throw new Error('Replay must not call a model'); } } });
  assert.equal(replay.result.verdict.passed, true);
  assert.equal(replayCalls, 0);

  // Without reinjection, the next document has no registrations or borrowed ownership.
  await goto(baseUrl);
  assert.equal((await driver.snapshot()).filter(row => row.name === 'Save' && row.role === 'button').length, 3);
  await evaluate(`return new Promise(resolve => {
    const frame = document.createElement('iframe');
    frame.srcdoc = ${JSON.stringify('<button onclick="parent.document.body.dataset.frameClicked=\'yes\'">Frame action</button>')};
    frame.onload = () => resolve({}); document.body.append(frame);
  });`);
  const framed = await driver.snapshot({ perception: true });
  const frameButton = framed.find(row => row.role === 'button' && row.name === 'Frame action');
  assert.ok(frameButton?.ref, 'An empty ownership scope must preserve document reference support');
  const frameTarget = await driver.locateRef(frameButton.ref);
  await driver.click(frameTarget, frameButton.ref);
  assert.match(await evaluate("return { clicked: document.body.dataset.frameClicked };"), /yes/);

  // Real accessible names, not fixture data-name attributes: both nested descendants
  // and reflected element references can carry host-only text into application rows.
  await goto(`${baseUrl}/names`);
  const beforeNames = await driver.snapshot({ perception: true });
  assert.ok(beforeNames.filter(row => row.role === 'button' && row.name === 'Host-only success').length >= 3);
  assert.ok(beforeNames.some(row => row.role === 'textbox' && row.name === 'Host-only success'));
  assert.match(await evaluate("return { attribute: document.getElementById('reflected').getAttribute('aria-labelledby') };"), /"attribute":\s*""/);
  await evaluate(`return (${hostOwnedRoots.registerScript})(document.getElementById('host'));`);
  for (const perception of [false, true]) {
    const sanitized = await driver.snapshot({ perception });
    assert.equal(sanitized.some(row => row.name.includes('Host-only success')), false);
    assert.ok(sanitized.some(row => row.name.includes('Application saved')), 'Direct body Text must remain');
    assert.ok(sanitized.some(row => row.name.includes('Shared application text')), 'Text sharing the panel parent must remain');
    assert.ok(sanitized.some(row => row.name === 'Application action'));
  }
  assert.equal(await conditionMet(driver, { text: 'Host-only success' }), false);
  assert.equal(await conditionMet(driver, { text: 'Application saved' }), true);
  await waitForCondition(driver, { text: 'Shared application text' }, 100);
  await assert.rejects(waitForCondition(driver, { text: 'Host-only success' }, 100), /timed out/);
  for (const selector of ['#nested', '#labelled', '#reflected', '#nested-reflected', '#described']) {
    await assert.rejects(driver.click({ selector }), /host-owned/);
  }
  const beforeRender = renderElements(await driver.snapshot({ perception: true }));
  await evaluate("document.getElementById('host-label').textContent = 'Host-only changed'; return {};");
  assert.equal(renderElements(await driver.snapshot({ perception: true })), beforeRender);
  assert.equal(await conditionMet(driver, { text: 'Host-only changed' }), false);
  await driver.click({ text: 'Application action', role: 'button' });
  assert.match(await evaluate("return { clicked: document.body.dataset.clicked };"), /yes/);

  // Real MCP compact capture retires the verbose-only named generic opener. Both
  // empty and active scopes must preserve that opener while reading the watermark.
  const selectScopes = [];
  for (const active of [false, true]) {
    await goto(`${baseUrl}/select`);
    if (active) await evaluate(`return (${hostOwnedRoots.registerScript})(document.getElementById('host'));`);
    const compact = await driver.call('take_snapshot');
    const verbose = await driver.call('take_snapshot', { verbose: true });
    assert.doesNotMatch(compact, /generic "Size"/);
    assert.match(verbose, /generic "Size"/);
    assert.match(compact, /option "Medium"/);
    await driver.select({ text: 'Size', role: 'generic' }, 'Medium');
    assert.match(await evaluate("return { selected: document.body.dataset.selected };"), /Medium/);
    assert.equal(await conditionMet(driver, { text: 'Selected Medium' }), true);
    selectScopes.push(active ? 'active' : 'empty');
  }
  console.log(JSON.stringify({ ordinaryCandidates: ordinary.length, perceptionCandidates: rows.length,
    hostTextCannotPass: true, overlayBlocked: true, frozenNth: 1, replayPassed: true, replayModelCalls: replayCalls,
    navigationRevokedOwnership: true, emptyScopeFrameRefPreserved: true, inputValueCapturePassed: true,
    networkAndConsolePreserved: true, nestedAndReflectedNamesExcluded: true, siblingApplicationTextPreserved: true,
    hostNameChurnIsNotProgress: true, verboseOnlySelectScopes: selectScopes, virtualAXCases: virtualCases,
    defaultReferenceScopes }, null, 2));
} finally {
  await driver.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
