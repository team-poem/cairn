// Real Chrome/MCP. A heading and a roleless widget have working click handlers but carry no
// `clickable` hint, so their eligibility is unknown and they stay usable. A host that measured the
// heading as click-disallowed gets it rejected before dispatch. A control under computed
// `pointer-events: none` is measured disallowed by the Chrome driver itself and rejected the same
// way, with no host hint. It sits below the fold because an on-screen one already fails the
// foreground hit test and is dropped from the listing as occluded. A pointer-events:none checkbox
// whose label still takes the pointer is checked through that label, and a control whose ::before or open shadow child takes the pointer is clicked through it, so each stays unknown. Scripted decisions, no model account.
// Build first. CAIRN_MCP_ENTRY may select an installed chrome-devtools-mcp 1.8.0.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ChromeDevToolsDriver, discover, explore, runScenario, startTrace } from '../packages/harness/dist/index.js';

const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/pointer') {
    res.end(`<!doctype html><title>Pointer through</title>
    <style>#pseudo::before { content: ''; display: block; width: 120px; height: 24px; pointer-events: auto; }</style>
    <button id="pseudo" aria-label="Pseudo go" style="pointer-events:none"></button>
    <div id="host" role="button" tabindex="0" aria-label="Shadow go" style="display:inline-block;pointer-events:none"></div>
    <script>
      window.clicks = [];
      document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<span style="display:block;width:120px;height:24px;pointer-events:auto">Go</span>';
      for (const id of ['pseudo', 'host']) document.querySelector('#' + id).addEventListener('click', () => clicks.push(id));
    </script>`);
    return;
  }
  res.end(`<!doctype html><title>Action candidates</title>
    <h1 id="heading">Alpha</h1>
    <a href="#" id="link">Alpha Curated goods from the Alpha store</a>
    <div id="widget">Open drawer</div>
    <div style="height:3000px"></div>
    <button id="blocked" style="pointer-events:none">Save draft</button>
    <label><input id="subscribe" type="checkbox" style="pointer-events:none"> Subscribe</label>
    <script>
      window.clicks = [];
      document.querySelector('#heading').addEventListener('click', () => clicks.push('heading'));
      document.querySelector('#link').addEventListener('click', e => { e.preventDefault(); clicks.push('link'); });
      document.addEventListener('click', e => { if (e.target.id === 'widget') clicks.push('widget'); });
      document.querySelector('#blocked').addEventListener('click', () => clicks.push('blocked'));
    </script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const flags = ['--isolated', '--headless', '--no-page-id-routing', '--no-usage-statistics'];
const options = process.env.CAIRN_MCP_ENTRY
  ? { command: process.execPath, args: [process.env.CAIRN_MCP_ENTRY, ...flags] }
  : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] };

const refOf = (prompt, marker) => {
  const ref = prompt.split('\n').find(row => row.includes('ref=') && row.includes(marker))?.match(/ref="([^"]+)"/)?.[1];
  assert.ok(ref, `the listing must carry an exact reference for ${marker}\n${prompt}`);
  return ref;
};
const pageClicks = async driver => {
  const reply = await driver.call('evaluate_script', { function: '() => window.clicks' }, 'observation');
  return JSON.parse(reply.match(/```json\s*([\s\S]*?)\s*```/)[1]);
};
const scripted = picks => { const prompts = []; return { prompts, llm: { id: 'scripted-candidates', async complete(prompt) {
  if (!prompt.includes('What is the single next action?')) return '[]';
  prompts.push(prompt);
  const pick = picks[prompts.length - 1];
  return pick ? JSON.stringify({ action: 'click', ref: refOf(prompt, pick) }) : '{"action":"done"}';
} } }; };

const report = [];
try {
  // Unknown stays usable: the real Driver measures no hint and no eligibility on these rows.
  let driver = new ChromeDevToolsDriver(options);
  let frozen;
  try {
    await driver.goto(baseUrl);
    const rows = await driver.snapshot({ perception: true });
    for (const name of ['Alpha', 'Open drawer']) {
      const row = rows.find(r => r.name === name);
      assert.ok(row, `${name} must be observed`);
      assert.equal(row.clickable, undefined, `${name} carries no clickable hint`);
      assert.equal(row.actions, undefined, `${name} carries no measured eligibility`);
    }
    const { llm, prompts } = scripted(['[heading] Alpha', 'Open drawer']);
    frozen = await discover('use the heading and the drawer', { driver, llm, baseUrl, maxSteps: 4 });
    assert.notEqual(frozen.truncated, true);
    assert.deepEqual(await pageClicks(driver), ['heading', 'widget']);
    assert.ok(!prompts[0].includes('Interactive elements'));
    assert.match(prompts[0], /Observed page elements:/);
    report.push({ case: 'unknown-usable', pageClicks: ['heading', 'widget'] });
  } finally { await driver.close(); }

  // Frozen replay is not gated: the same steps run again with no model call. The verdict is
  // all-vacuous for this click-only fixture, so only dispatch is asserted.
  driver = new ChromeDevToolsDriver(options);
  try {
    let modelCalls = 0;
    await runScenario(frozen, { driver, reporter: { async emit() {} },
      llm: { id: 'forbidden', async complete() { modelCalls++; throw new Error('replay called a model'); } } });
    assert.equal(modelCalls, 0);
    assert.deepEqual(await pageClicks(driver), ['heading', 'widget']);
    report.push({ case: 'replay', modelCalls, pageClicks: ['heading', 'widget'] });
  } finally { await driver.close(); }

  // A host-supplied measurement through `perceive`: the heading click is refused before dispatch.
  for (const mode of ['discover', 'explore']) {
    driver = new ChromeDevToolsDriver(options);
    const gates = [];
    const trace = startTrace({ emit: e => { if (e.kind === 'gate') gates.push(e.payload); } }, 'candidates').scope('candidates');
    try {
      const { llm, prompts } = scripted(['[heading] Alpha', '[link] Alpha Curated']);
      const perceive = rows => rows.map(r => r.role === 'heading' ? { ...r, actions: { click: 'disallowed' } } : r);
      const opts = { driver, llm, baseUrl, maxSteps: 4, perceive, trace };
      if (mode === 'discover') await discover('open Alpha', opts); else await explore('survey Alpha', opts);
      assert.deepEqual(await pageClicks(driver), ['link'], 'the heading handler must never fire');
      assert.match(prompts[1], /not run: the observed target is measured as not accepting "click"/);
      assert.deepEqual(gates, [{ gate: 'action-eligibility', action: 'click', reason: 'measured-disallowed' }]);
      report.push({ case: `disallowed-${mode}`, pageClicks: ['link'] });
    } finally { await driver.close(); }
  }
  // A measurement from the Driver itself: no `perceive` hint. The same click on a pointer-events:none
  // button reports success but never reaches its handler, which is why the engine must not dispatch it.
  for (const mode of ['discover', 'explore']) {
    driver = new ChromeDevToolsDriver(options);
    const gates = [];
    const trace = startTrace({ emit: e => { if (e.kind === 'gate') gates.push(e.payload); } }, 'measured').scope('measured');
    try {
      await driver.goto(baseUrl);
      const rows = await driver.snapshot({ perception: true });
      const blocked = rows.filter(r => r.name === 'Save draft');
      assert.ok(blocked.length > 0, 'the blocked button must be observed');
      for (const row of blocked) assert.deepEqual(row.actions, { click: 'disallowed', doubleClick: 'disallowed', hover: 'disallowed' });
      for (const name of ['Alpha', 'Open drawer']) assert.equal(rows.find(r => r.name === name).actions, undefined);
      if (mode === 'discover') {
        await driver.click({ text: 'Save draft' });
        assert.deepEqual(await pageClicks(driver), [], 'a direct driver click reaches no handler');
      }
      const { llm, prompts } = scripted(['[button] Save draft', '[link] Alpha Curated']);
      const opts = { driver, llm, baseUrl, maxSteps: 4, trace };
      if (mode === 'discover') await discover('open Alpha', opts); else await explore('survey Alpha', opts);
      assert.deepEqual(await pageClicks(driver), ['link']);
      assert.match(prompts[1], /not run: the observed target is measured as not accepting "click"/);
      assert.deepEqual(gates, [{ gate: 'action-eligibility', action: 'click', reason: 'measured-disallowed' }]);
      report.push({ case: `measured-${mode}`, pageClicks: ['link'] });
    } finally { await driver.close(); }
  }
  // The click on a pointer-events:none checkbox lands on its wrapping label and checks it, so
  // measuring it disallowed would refuse a click that works.
  driver = new ChromeDevToolsDriver(options);
  try {
    await driver.goto(baseUrl);
    const row = (await driver.snapshot({ perception: true })).find(r => r.role === 'checkbox');
    assert.ok(row, 'the labelled checkbox must be observed');
    assert.equal(row.actions, undefined, 'a label-activatable control stays unknown');
    await driver.click({ text: row.name }, row.ref);
    const reply = await driver.call('evaluate_script', { function: '() => document.querySelector("#subscribe").checked' }, 'observation');
    assert.equal(JSON.parse(reply.match(/```json\s*([\s\S]*?)\s*```/)[1]), true, 'the click checks the box through its label');
    report.push({ case: 'label-activated', checked: true });
  } finally { await driver.close(); }
  // A pseudo-element or an open shadow child that opts back in receives the click and
  // dispatches it to the row, so measuring the row disallowed would refuse a click that works.
  for (const [name, id] of [['Pseudo go', 'pseudo'], ['Shadow go', 'host']]) {
    driver = new ChromeDevToolsDriver(options);
    try {
      await driver.goto(`${baseUrl}/pointer`);
      const row = (await driver.snapshot({ perception: true })).find(r => r.name === name);
      assert.ok(row, `${name} must be observed`);
      assert.equal(row.actions, undefined, `${name} stays unknown`);
      await driver.click({ text: row.name }, row.ref);
      assert.deepEqual(await pageClicks(driver), [id], `the click reaches the ${id} handler`);
      report.push({ case: `pointer-through-${id}`, pageClicks: [id] });
    } finally { await driver.close(); }
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
