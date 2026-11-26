// Real MCP discovery of a declared positional selection, then zero-model replay after the list changes.
// The selection also declares a readerId (#370): a host driver serves it, and the built-in reader refuses it.
// Build first. CAIRN_MCP_ENTRY may point to an installed MCP 1.8.0 executable entry.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChromeDevToolsDriver, discover, loadSkillFile, runScenario, saveSkillFile, selectedItemEquals } from '../packages/harness/dist/index.js';

let ids = ['alpha', 'beta'];
let wrongDetail = false;
const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.setHeader('Content-Type', 'text/html');
  const open = id => wrongDetail ? 'gamma' : id;
  res.end(`<!doctype html><title>Posts</title>
    <ul aria-label="Posts">${ids.map(id => `<li data-post-id="${id}"><h2>${id}</h2>
      <button onclick="const d=document.querySelector('#post');d.dataset.postId='${open(id)}';d.innerHTML='<h1>Details</h1>'">Open</button></li>`).join('')}</ul>
    <section id="post"></section>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/posts`;
const flags = ['--isolated', '--headless', '--viewport=1280x800', '--no-page-id-routing', '--no-usage-statistics'];
const transport = process.env.CAIRN_MCP_ENTRY
  ? { command: process.execPath, args: [process.env.CAIRN_MCP_ENTRY, ...flags] }
  : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] };
/** A host that owns one reader and declares it. It strips the ID before delegating to the built-in reader. */
class HostDriver extends ChromeDevToolsDriver {
  readerIds = ['posts.v2'];
  seen = [];
  async observeCollection(selection) {
    this.seen.push(selection.readerId);
    const { readerId, ...rest } = selection;
    return super.observeCollection(rest);
  }
}
const driver = new HostDriver({ ...transport, settle: { idleMs: 50, pollMs: 25, timeoutMs: 500 } });
const selection = {
  version: 1, id: 'first-post',
  target: { collection: { root: { role: 'list', name: 'Posts' }, readerId: 'posts.v2', itemRole: 'listitem', target: { role: 'button', name: 'Open' },
    order: 'dom', index: 0, expectedCount: 2 } },
  expect: { role: 'heading', text: 'Details' },
  verify: { source: { kind: 'attribute', scope: 'item', attribute: 'data-post-id' },
    destination: { kind: 'attribute', selector: '#post', attribute: 'data-post-id' } },
};
const replies = [JSON.stringify({ action: 'click', selection: 'first-post', reason: 'open alpha' }), JSON.stringify({ action: 'done' })];
const llm = { id: 'scripted', complete: async () => replies.shift() ?? '[]' };
const noModel = { id: 'forbidden', complete: async () => { throw new Error('replay called a model'); } };
const directory = await mkdtemp(join(tmpdir(), 'cairn-discovery-selection-'));
try {
  const scenario = await discover('Open the first post', { driver, llm, baseUrl, selections: [selection] });
  assert.equal(scenario.truncated, undefined, `discovery stopped: ${scenario.truncationReason}`);
  assert.match(await driver.call('evaluate_script', { function: "() => document.querySelector('#post').dataset.postId" }), /alpha/);
  const path = join(directory, 'first-post.skill.json');
  await saveSkillFile(path, scenario);
  const raw = await readFile(path, 'utf8');
  assert.doesNotMatch(raw, /alpha|cairn-collection:/, 'the freeze must not keep the discovered member');
  assert.equal(JSON.parse(raw).steps[1].target.collection.readerId, 'posts.v2', 'the saved step keeps the reader ID');
  const loaded = await loadSkillFile(path);
  assert.equal(loaded.steps[1].target.collection.readerId, 'posts.v2', 'the loaded step keeps the reader ID');
  const bindings = loaded.assertions.filter(a => a.kind === 'custom').map(a => a.params);
  assert.equal(bindings.length, 1);
  const replay = () => runScenario(loaded, { driver, llm: noModel, reporter: { emit: async () => {} }, judgmentKey: 'posts-v1',
    selectedItemEvidence: { bindings }, custom: { 'first-post': selectedItemEquals } });

  ids = ['beta', 'alpha'];
  driver.seen.length = 0;
  const changed = await replay();
  assert.deepEqual(driver.seen, ['posts.v2'], 'replay passes the saved reader ID to observeCollection');
  assert.equal(changed.result.verdict.passed, true, changed.result.verdict.detail);
  assert.match(await driver.call('evaluate_script', { function: "() => document.querySelector('#post').dataset.postId" }), /beta/);
  assert.equal(changed.result.usage.llmCalls, 0);

  wrongDetail = true;
  const mismatched = await replay();
  assert.equal(mismatched.result.verdict.passed, false, 'selecting beta and arriving at gamma must fail');
  assert.equal(mismatched.result.usage.llmCalls, 0);
  wrongDetail = false;
  const unknown = structuredClone(loaded);
  unknown.steps[1].target.collection.readerId = 'posts.v9';
  await driver.goto(baseUrl);
  driver.seen.length = 0;
  const unsupported = await runScenario(unknown, { driver, llm: noModel, reporter: { emit: async () => {} }, judgmentKey: 'posts-v1',
    selectedItemEvidence: { bindings }, custom: { 'first-post': selectedItemEquals } });
  assert.equal(unsupported.result.verdict.passed, false, 'an unsupported reader ID must fail the replay');
  assert.deepEqual(driver.seen, [], 'core refuses an unlisted reader ID before the driver observes anything');
  assert.match(await driver.call('evaluate_script', { function: "() => document.querySelector('#post').dataset.postId ?? null" }), /null/, 'no click may follow an unsupported reader ID');
  await assert.rejects(ChromeDevToolsDriver.prototype.observeCollection.call(driver, selection.target.collection), /readerId/, 'the built-in reader refuses a declared ID');
  console.log(JSON.stringify({ frozenStep: loaded.steps[1], changedFirst: 'beta', mismatchRejected: true, unsupportedReaderRefused: true, replayModelCalls: 0 }, null, 2));
} finally {
  await driver.close();
  server.close();
  await rm(directory, { recursive: true, force: true });
}
