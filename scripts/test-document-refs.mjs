// Real Chrome + MCP verification; no network service or LLM account required.
// Build first, then npm run test:document-refs. CAIRN_MCP_ENTRY can select an installed 1.8.0 tool.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const runtime = process.argv[2] ? pathToFileURL(process.argv[2]) : new URL('../packages/harness/dist/index.js', import.meta.url);
const { ChromeDevToolsDriver, runScenario, saveSkillFile, loadSkillFile } = await import(runtime.href);
const mcp = process.argv[3] ?? process.env.CAIRN_MCP_ENTRY;
const clicks = [];
const ready = new Set();
const button = name => `<button onclick="fetch('/clicked?document=${name}')">Save</button>`;
let base;
let cross;
function serve(req, res) {
  const url = new URL(req.url, base);
  if (url.pathname === '/clicked') { clicks.push(url.searchParams.get('document')); res.end('ok'); return; }
  if (url.pathname === '/ready') { ready.add(url.searchParams.get('document')); res.end('ok'); return; }
  res.setHeader('Content-Type', 'text/html');
  const style = '<style>iframe{display:block;width:600px;height:180px;border:0}button{margin:4px}</style>';
  const body = url.pathname === '/' ? `<title>Main</title>${button('main')}<iframe id="same" title="Same" src="/same"></iframe>${button('middle')}<iframe id="cross" title="Cross" src="${cross}/cross"></iframe><iframe id="empty" src="/empty"></iframe>`
    : url.pathname === '/same' ? `<title>Same</title>${button('same')}<iframe title="Nested" src="/nested"></iframe>`
    : url.pathname === '/cross' ? `<title>Cross</title>${button('cross')}`
    : url.pathname === '/nested' ? `<title>Nested</title>${button('nested')}`
    : '<title></title>';
  res.end(`<!doctype html>${style}${body}<script>fetch('/ready?document=' + encodeURIComponent(location.pathname))</script>`);
}
const rootServer = createServer(serve);
const crossServer = createServer(serve);
await new Promise(resolve => rootServer.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => crossServer.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${rootServer.address().port}`;
cross = `http://localhost:${crossServer.address().port}`;
const flags = ['--isolated', '--headless', '--no-page-id-routing', '--no-usage-statistics'];
const options = {
  ...(mcp ? { command: process.execPath, args: [mcp, ...flags] }
    : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] }),
  timeoutMs: 20000, connectTimeoutMs: 30000,
};
const driver = new ChromeDevToolsDriver(options);
let clickDispatches = 0;
const call = driver.call.bind(driver);
driver.call = async (name, args, purpose) => {
  if (name === 'click') clickDispatches++;
  try {
    const reply = await call(name, args, purpose);
    if (process.env.CAIRN_DOCUMENT_REFS_DEBUG) console.error(JSON.stringify({ name, args, reply }));
    return reply;
  } catch (error) {
    if (process.env.CAIRN_DOCUMENT_REFS_DEBUG) console.error(JSON.stringify({ name, args, error: error.message }));
    throw error;
  }
};
const scratch = await mkdtemp(join(tmpdir(), 'cairn-document-refs-'));
const report = { exact: [], rejected: [], replay: null };
const expected = ['main', 'same', 'nested', 'middle', 'cross'];
async function flushClicks(length) {
  for (let attempt = 0; attempt < 50 && clicks.length < length; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(clicks.length, length);
}
async function goReady(browserDriver) {
  ready.clear();
  await browserDriver.goto(base);
  for (let attempt = 0; attempt < 200 && ready.size < 5; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual([...ready].sort(), ['/', '/cross', '/empty', '/nested', '/same']);
  // MCP's frame bookkeeping can lag the child's load event. Wait for the advertised AX
  // document tree before testing stable-capture references; incomplete trees must fail closed.
  for (let attempt = 0; attempt < 20; attempt++) {
    const raw = await browserDriver.call('take_snapshot', { verbose: true });
    if ((raw.match(/\bRootWebArea\b/g) ?? []).length === 5) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('MCP did not expose all five loaded fixture documents');
}
try {
  await goReady(driver);
  const targets = [];
  for (let index = 0; index < expected.length; index++) {
    const rows = await driver.snapshot({ perception: true });
    const buttons = rows.filter(row => row.role === 'button' && row.name === 'Save');
    assert.equal(buttons.length, expected.length, JSON.stringify({ index, rows }));
    assert.ok(buttons.every(row => typeof row.ref === 'string'), JSON.stringify(rows));
    const target = await driver.locateRef(buttons[index].ref);
    assert.deepEqual(target, { text: 'Save', role: 'button', index, nth: index });
    targets.push(target);
    await driver.click(target, buttons[index].ref);
    await flushClicks(index + 1);
    assert.equal(clicks[index], expected[index]);
    report.exact.push({ document: expected[index], target });
  }
  const skillPath = join(scratch, 'documents.skill.json');
  await saveSkillFile(skillPath, { name: 'Cross-document duplicate Save replay', steps: [{ kind: 'goto', url: base }, ...['/', '/same', '/nested', '/cross', '/empty'].map(document => ({ kind: 'waitFor', until: { requestStatus: { urlIncludes: `/ready?document=${encodeURIComponent(document)}`, status: 200 } } })), ...targets.map(target => ({ kind: 'click', target }))], assertions: [{ kind: 'custom', name: 'ordered-clicks' }] });
  const serialized = await readFile(skillPath, 'utf8');
  assert.ok(!serialized.match(/ref|token|uid/i));
  const scenario = await loadSkillFile(skillPath);
  clicks.length = 0;
  const replayDriver = new ChromeDevToolsDriver(options);
  try {
    const result = await runScenario(scenario, { driver: replayDriver, heal: false, llm: { id: 'forbidden', complete: async () => { throw new Error('Replay called an LLM'); } }, custom: { 'ordered-clicks': async () => { await flushClicks(expected.length); return JSON.stringify(clicks) === JSON.stringify(expected); } } });
    assert.equal(result.result.verdict.passed, true, JSON.stringify(result));
    assert.deepEqual(clicks, expected);
    assert.equal(result.result.usage.llmCalls, 0);
    report.replay = { clicks: [...clicks], llmCalls: result.result.usage.llmCalls, scenario };
  } finally { await replayDriver.close(); }
  const mutations = {
    'empty-frame-first-duplicate': `() => { document.querySelector('#empty').contentDocument.body.innerHTML = '<button>Save</button>'; }`,
    'identical-role-frame-reorder': `() => { document.body.insertBefore(document.querySelector('#cross'), document.querySelector('#same')); }`,
    'frame-detach': `() => document.querySelector('#same').remove()`,
    'same-url-reload': `async () => { const frame = document.querySelector('#same'); await new Promise(resolve => { frame.addEventListener('load', resolve, {once:true}); frame.src = frame.src; }); }`,
    'owner-replacement': `async () => { const old = document.querySelector('#same'); const frame = old.cloneNode(); await new Promise(resolve => { frame.addEventListener('load', resolve, {once:true}); old.replaceWith(frame); }); }`,
    'new-empty-frame': `async () => { const frame = document.createElement('iframe'); frame.src = '/empty'; await new Promise(resolve => { frame.addEventListener('load', resolve, {once:true}); document.body.append(frame); }); }`,
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    for (const cached of [false, true]) {
      await goReady(driver);
      const rows = await driver.snapshot({ perception: true });
      const selected = rows.find(row => row.role === 'button' && row.name === 'Save');
      assert.ok(selected.ref);
      const target = cached ? await driver.locateRef(selected.ref) : undefined;
      await driver.call('evaluate_script', { function: mutate });
      const previous = clicks.length;
      const previousDispatches = clickDispatches;
      if (cached) await assert.rejects(driver.click(target, selected.ref), { kind: 'resolution' });
      else await assert.rejects(driver.locateRef(selected.ref), { kind: 'resolution' });
      assert.equal(clickDispatches, previousDispatches, `${name}: expired ref dispatched a click`);
      assert.equal(clicks.length, previous);
      report.rejected.push(`${name}:${cached ? 'before-action' : 'before-locate'}`);
    }
  }
  console.log(JSON.stringify(report, null, 2));
  if (process.env.CAIRN_DOCUMENT_REFS_REPORT) await writeFile(process.env.CAIRN_DOCUMENT_REFS_REPORT, JSON.stringify(report, null, 2));
} finally {
  await driver.close();
  await Promise.all([rootServer, crossServer].map(server => new Promise(resolve => server.close(resolve))));
  await rm(scratch, { recursive: true, force: true });
}
