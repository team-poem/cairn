// Real MCP discovery of a declared position over plain links, then zero-model replay with full
// navigation after the grid changes. Build first. CAIRN_MCP_ENTRY may point to an installed MCP 1.8.0 entry.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChromeDevToolsDriver, discover, loadSkillFile, runScenario, saveSkillFile, selectedItemEquals } from '../packages/harness/dist/index.js';

let ids = ['alpha', 'bravo', 'charlie'];
let cards = false;
let stay = false;
let closeOnClick = false;
const newTab = new Set();
const redirects = new Map();
const opened = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (url.pathname.startsWith('/posts/')) {
    const id = url.pathname.slice('/posts/'.length);
    opened.push(id);
    if (redirects.has(id)) { res.writeHead(302, { Location: `/posts/${redirects.get(id)}` }); res.end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>${id}</title><h1>Details</h1><p>${id}</p>`);
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  const grid = cards
    ? `<section id="feed">${ids.map(id => `<article class="card">${id === ids[0] ? '<span>Official</span>' : ''}
        <a href="/posts/${id}"><img alt="${id} cover" width="40" height="40"></a><a href="/posts/${id}">${id}</a></article>`).join('')}</section>`
    : `<div class="grid">${ids.map(id => `<a href="/posts/${id}"${newTab.has(id) ? ' target="_blank"' : ''}${stay ? ' onclick="event.preventDefault()"'
      : closeOnClick ? ' onclick="event.preventDefault(); window.close()"' : ''}>${id}</a>`).join('')}</div>`;
  res.end(`<!doctype html><title>Posts</title><nav><a href="/about">About</a></nav>${grid}`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const flags = ['--isolated', '--headless', '--viewport=1280x800', '--no-page-id-routing', '--no-usage-statistics'];
const transport = process.env.CAIRN_MCP_ENTRY
  ? { command: process.execPath, args: [process.env.CAIRN_MCP_ENTRY, ...flags] }
  : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] };
const driver = new ChromeDevToolsDriver({ ...transport, settle: { idleMs: 50, pollMs: 25, timeoutMs: 1500 } });
const noModel = { id: 'forbidden', complete: async () => { throw new Error('replay called a model'); } };
const directory = await mkdtemp(join(tmpdir(), 'cairn-link-selection-'));

async function discoverAndLoad(selection) {
  const replies = [JSON.stringify({ action: 'click', selection: selection.id, reason: 'open the declared post' }), JSON.stringify({ action: 'done' })];
  const llm = { id: 'scripted', complete: async () => replies.shift() ?? '[]' };
  const scenario = await discover('Open the second post', { driver, llm, baseUrl: `${origin}/posts`, selections: [selection] });
  assert.equal(scenario.truncated, undefined, `discovery stopped: ${scenario.truncationReason}`);
  const path = join(directory, `${selection.id}.skill.json`);
  await saveSkillFile(path, scenario);
  const raw = await readFile(path, 'utf8');
  assert.doesNotMatch(raw, /bravo|cairn-collection:/, 'the freeze must not keep the discovered link');
  return loadSkillFile(path);
}

const replay = loaded => runScenario(loaded, { driver, llm: noModel, reporter: { emit: async () => {} }, judgmentKey: 'posts-v1',
  selectedItemEvidence: { bindings: loaded.assertions.filter(a => a.kind === 'custom').map(a => a.params), timeoutMs: 15_000 },
  custom: { [loaded.assertions.find(a => a.kind === 'custom').name]: selectedItemEquals } });
const here = () => driver.call('evaluate_script', { function: '() => location.pathname' });

try {
  const loaded = await discoverAndLoad({
    version: 1, id: 'second-post',
    target: { collection: { links: { scope: '.grid', member: ':scope > a' }, order: 'dom', index: 1, expectedCount: 3 } },
    verify: { source: { kind: 'href' }, destination: { kind: 'location' } },
  });
  assert.deepEqual(opened, ['bravo'], 'discovery opens the second link');

  ids = ['charlie', 'alpha', 'bravo'];
  opened.length = 0;
  const reordered = await replay(loaded);
  assert.equal(reordered.result.verdict.passed, true, reordered.result.verdict.detail);
  assert.deepEqual(opened, ['alpha'], 'replay opens the current second link, not the discovered one');
  assert.match(await here(), /\/posts\/alpha/);
  assert.equal(reordered.result.usage.llmCalls, 0);

  redirects.set('alpha', 'charlie');
  opened.length = 0;
  const mismatched = await replay(loaded);
  assert.deepEqual(opened, ['alpha', 'charlie']);
  assert.equal(mismatched.result.verdict.passed, false, 'selecting alpha and arriving at charlie must fail');
  assert.equal(mismatched.result.verdict.results.find(r => r.assertion.kind === 'custom')?.passed, false);
  assert.equal(mismatched.result.usage.llmCalls, 0);
  redirects.clear();

  stay = true;
  opened.length = 0;
  const stayed = await replay(loaded);
  assert.deepEqual(opened, [], 'the click is swallowed and no document loads');
  assert.equal(stayed.result.verdict.passed, false, 'a click that never leaves the list must not pass');
  assert.equal(stayed.result.verdict.results.find(r => r.assertion.kind === 'custom')?.reason, 'inconclusive');
  stay = false;

  // The run's tab closes on the click, so Chrome selects the other tab, which already shows the expected post.
  await driver.call('navigate_page', { type: 'url', url: `${origin}/posts/alpha` });
  await driver.call('evaluate_script', { function: `() => { window.open(${JSON.stringify(`${origin}/posts`)}); return {}; }` });
  const runTab = [...(await driver.call('list_pages')).matchAll(/^\s*(\d+):/gm)].map(match => Number(match[1])).at(-1);
  await driver.call('select_page', { pageId: runTab });
  closeOnClick = true;
  opened.length = 0;
  const switched = await replay(loaded);
  assert.match(await here(), /\/posts\/alpha/, 'the selected tab is now the other one');
  assert.equal(switched.result.verdict.passed, false, 'an arrival read in another tab must not pass');
  assert.equal(switched.result.verdict.results.find(r => r.assertion.kind === 'custom')?.reason, 'inconclusive');
  closeOnClick = false;

  // Discovery refuses a new-tab link before clicking it, as replay does.
  ids = ['alpha', 'bravo', 'charlie'];
  newTab.add('bravo');
  opened.length = 0;
  await assert.rejects(discoverAndLoad({
    version: 1, id: 'new-tab-post',
    target: { collection: { links: { scope: '.grid', member: ':scope > a' }, order: 'dom', index: 1, expectedCount: 3 } },
    verify: { source: { kind: 'href' }, destination: { kind: 'location' } },
  }), /selection-failed/);
  assert.deepEqual(opened, [], 'discovery must not open a new-tab link');
  newTab.clear();

  cards = true;
  ids = ['alpha', 'bravo', 'charlie'];
  opened.length = 0;
  const grouped = await discoverAndLoad({
    version: 1, id: 'second-card',
    target: { collection: { links: { scope: '#feed', member: ':scope > .card', action: 'a[href]', group: 'destination' },
      order: 'dom', index: 1, expectedCount: 3 } },
    verify: { source: { kind: 'href' }, destination: { kind: 'location' } },
  });
  ids = ['charlie', 'alpha', 'bravo'];
  opened.length = 0;
  const cardReplay = await replay(grouped);
  assert.equal(cardReplay.result.verdict.passed, true, cardReplay.result.verdict.detail);
  assert.deepEqual(opened, ['alpha'], 'a badged first card still counts and the grouped second card opens once');
  assert.equal(cardReplay.result.usage.llmCalls, 0);

  console.log(JSON.stringify({ frozenStep: loaded.steps[1], reorderedOpened: 'alpha', mismatchRejected: true, missingArrivalInconclusive: true,
    switchedTabInconclusive: true, newTabRefusedInDiscovery: true, groupedCardOpened: 'alpha', replayModelCalls: 0 }, null, 2));
} finally {
  await driver.close();
  server.close();
  await rm(directory, { recursive: true, force: true });
}
