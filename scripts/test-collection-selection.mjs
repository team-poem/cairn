// Real MCP AX serialization, exact-node guards, explicit freeze and zero-model replay.
// Build first. CAIRN_MCP_ENTRY may point to an installed MCP 1.8.0 executable entry.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ChromeDevToolsDriver, createHostOwnedRootScope, runScenario } from '../packages/harness/dist/index.js';
import { resolveCollectionTarget } from '../packages/harness/dist/core/collection.js';

let reverse = false;
const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.setHeader('Content-Type', 'text/html');
  if (req.url.startsWith('/done/')) { res.end('<!doctype html><title>Done</title><h1>Selected current first result</h1>'); return; }
  const replay = req.url === '/replay';
  const ids = reverse ? ['beta', 'alpha'] : ['alpha', 'beta'];
  const item = id => `<li id="${id}" aria-setsize="2" aria-posinset="${ids.indexOf(id) + 1}"><h2>${id}</h2>
    <button id="${id}-action" onclick="${replay ? `location.href='/done/${id}'` : `document.body.dataset.clicked='${id}'`}">Open</button>
    ${id === 'alpha' ? '<ul aria-label="Nested"><li><button id="nested-action" onclick="document.body.dataset.clicked=\'nested\'">Open</button></li></ul>' : ''}</li>`;
  res.end(`<!doctype html><title>Collection fixture</title>
    <label>Search<input id="query" aria-label="Search" value="cats"></label>
    <label><input id="filter" aria-label="In stock" type="checkbox" checked>In stock</label>
    <select id="sort" aria-label="Sort"><option value="rank">Relevance</option><option value="name">Name</option></select>
    ${replay ? '' : '<aside id="host"><ul aria-label="Search results"><li><button id="host-action" onclick="document.body.dataset.clicked=\'host\'">Open</button></li></ul></aside>'}
    <ul id="results" aria-label="Search results">${ids.map(item).join('')}</ul>
    <ul aria-label="Other"><li><button id="other-action" onclick="document.body.dataset.clicked='other'">Open</button></li></ul>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const flags = ['--isolated', '--headless', '--viewport=1280x800', '--no-page-id-routing', '--no-usage-statistics'];
const transport = process.env.CAIRN_MCP_ENTRY
  ? { command: process.execPath, args: [process.env.CAIRN_MCP_ENTRY, ...flags] }
  : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] };
const hostOwnedRoots = createHostOwnedRootScope();
const driver = new ChromeDevToolsDriver({ ...transport, hostOwnedRoots,
  settle: { idleMs: 50, pollMs: 25, timeoutMs: 500 } });
const evaluate = source => driver.call('evaluate_script', { function: `() => { ${source} }` });
const fresh = async () => {
  reverse = false;
  await driver.goto(`${baseUrl}/probe`);
  await evaluate(`return (${hostOwnedRoots.registerScript})(document.querySelector('#host'));`);
};
const declaration = {
  collection: { root: { role: 'list', name: 'Search results' }, itemRole: 'listitem', target: { role: 'button', name: 'Open' },
    order: 'dom', index: 0, expectedCount: 2,
    conditions: [
      { control: { role: 'textbox', name: 'Search' }, value: 'cats' },
      { control: { role: 'checkbox', name: 'In stock' }, checked: true },
      { control: { role: 'combobox', name: 'Sort' }, value: 'rank' },
    ] },
};
try {
  await fresh();
  const observation = await driver.observeCollection(declaration.collection);
  assert.equal(observation.complete, true);
  assert.equal(observation.items.length, 2, 'Nested and host-owned items must not enter the outer pool');
  assert.ok(observation.items.every(item => item.target?.ref?.startsWith('cairn-collection:')));
  const first = await resolveCollectionTarget(driver, declaration);
  await driver.click(first.target, first.ref);
  assert.match(await evaluate('return {clicked:document.body.dataset.clicked};'), /alpha/);

  const refused = [];
  for (const [name, mutation] of [
    ['reorder', "document.querySelector('#results').prepend(document.querySelector('#beta'))"],
    ['replace', "document.querySelector('#alpha-action').replaceWith(document.querySelector('#alpha-action').cloneNode(true))"],
    ['disabled', "document.querySelector('#alpha-action').disabled = true"],
    ['query', "document.querySelector('#query').value = 'dogs'"],
    ['filter', "document.querySelector('#filter').checked = false"],
    ['sort', "document.querySelector('#sort').value = 'name'"],
  ]) {
    await fresh();
    const bound = await resolveCollectionTarget(driver, declaration);
    await evaluate(`${mutation}; return {};`);
    await assert.rejects(driver.click(bound.target, bound.ref), /collection|expired|Host ownership/);
    assert.doesNotMatch(await evaluate('return {clicked:document.body.dataset.clicked};'), /alpha|beta|host|nested/);
    refused.push(name);
  }
  for (const [name, mutation] of [
    ['partial', "document.querySelector('#alpha').setAttribute('aria-setsize','20')"],
    ['hidden', "document.querySelector('#beta').hidden = true"],
    ['missing-action', "document.querySelector('#alpha-action').remove()"],
  ]) {
    await fresh();
    await evaluate(`${mutation}; return {};`);
    await assert.rejects(resolveCollectionTarget(driver, declaration), /collection selection/);
    refused.push(name);
  }
  await fresh();
  const ariaOnly = structuredClone(declaration);
  delete ariaOnly.collection.expectedCount;
  assert.ok((await resolveCollectionTarget(driver, ariaOnly)).ref, 'Positive complete ARIA metadata is sufficient');
  await evaluate("document.querySelectorAll('#results > li').forEach(el => { el.removeAttribute('aria-setsize'); el.removeAttribute('aria-posinset'); }); return {}; ");
  await assert.rejects(resolveCollectionTarget(driver, ariaOnly), /incomplete/);

  // Regression: empty accessible names are valid with an explicit role-only scope.
  await fresh();
  await evaluate("document.querySelector('#alpha-action').textContent = ''; document.querySelector('#alpha-action').style.cssText = 'width:100px;height:30px'; return {};");
  const unnamed = structuredClone(declaration);
  delete unnamed.collection.target.name;
  const unnamedRef = await resolveCollectionTarget(driver, unnamed);
  assert.equal(unnamedRef.target.text, '');
  await driver.click(unnamedRef.target, unnamedRef.ref);
  assert.match(await evaluate('return {clicked:document.body.dataset.clicked};'), /alpha/);
  await evaluate("document.querySelector('#alpha').append(document.querySelector('#alpha-action').cloneNode(true)); return {};");
  await assert.rejects(resolveCollectionTarget(driver, unnamed), /incomplete/);

  // Regression: native listboxes are DOM collections, including size-only listboxes.
  for (const mode of ['multiple', 'size="3"']) {
    await fresh();
    await evaluate(`document.body.insertAdjacentHTML('beforeend', '<select ${mode} aria-label="Native choices"><option value="a">Same</option><option value="b">Same</option></select>'); return {};`);
    const native = { collection: { root: { role: 'listbox', name: 'Native choices' }, itemRole: 'option',
      target: { role: 'option' }, order: 'dom', index: 1, expectedCount: 2 } };
    const bound = await resolveCollectionTarget(driver, native);
    await driver.click(bound.target, bound.ref);
    assert.match(await evaluate('return {selected:document.querySelector("[aria-label=\\"Native choices\\"]").value};'), /"selected":\s*"b"/);
    await evaluate('document.querySelector("[aria-label=\\"Native choices\\"]").options[1].disabled=true; return {};');
    await assert.rejects(resolveCollectionTarget(driver, native), /disabled/);
  }

  // Regression: a two-stage custom select must not commit after prerequisites drift.
  // This adapter currently refuses before opening; native fills retain their exact-node path.
  await fresh();
  await evaluate(`const opener=document.querySelector('#alpha-action'); opener.setAttribute('role','combobox'); opener.setAttribute('aria-label','Open');
    opener.onclick=()=>{document.querySelector('#query').value='dogs';document.body.dataset.clicked='wrong-resource';}; return {};`);
  const custom = structuredClone(declaration);
  custom.collection.target.role = 'combobox';
  const customRef = await resolveCollectionTarget(driver, custom);
  await assert.rejects(driver.select(customRef.target, 'Chosen', customRef.ref), /collection select requires a native select/);
  assert.match(await evaluate('return {query:document.querySelector("#query").value,clicked:document.body.dataset.clicked};'), /"query":\s*"cats"/);
  assert.doesNotMatch(await evaluate('return {clicked:document.body.dataset.clicked};'), /wrong-resource/);
  await fresh();
  await evaluate(`document.querySelector('#alpha-action').outerHTML='<select aria-label="Choose"><option value="a">A</option><option value="b">B</option></select>'; return {};`);
  const fill = structuredClone(custom);
  fill.collection.target.name = 'Choose';
  const fillRef = await resolveCollectionTarget(driver, fill);
  await driver.select(fillRef.target, 'b', fillRef.ref);
  assert.match(await evaluate('return {selected:document.querySelector("[aria-label=Choose]").value};'), /"selected":\s*"b"/);

  // Unsupported matching nodes outside the scope cannot poison its positive coverage.
  await fresh();
  await evaluate(`document.body.appendChild(document.createElement('div')).attachShadow({mode:'open'}).innerHTML='<ul><li><button>Open</button></li></ul>'; return {};`);
  const externalShadow = await resolveCollectionTarget(driver, declaration);
  await driver.click(externalShadow.target, externalShadow.ref);
  assert.match(await evaluate('return {clicked:document.body.dataset.clicked};'), /alpha/);
  await evaluate(`document.querySelector('#alpha').appendChild(document.createElement('div')).attachShadow({mode:'closed'}).innerHTML='<button>Open</button>'; return {};`);
  await assert.rejects(resolveCollectionTarget(driver, declaration), /incomplete/);

  const frozen = JSON.parse(JSON.stringify({ name: 'Current first result', wildcards: true,
    steps: [{ kind: 'goto', url: `${baseUrl}/replay` }, { kind: 'click', target: declaration }],
    assertions: [{ kind: 'navigated', to: `${baseUrl}/done/*` }] }));
  assert.doesNotMatch(JSON.stringify(frozen), /cairn(?:-collection)?:/);
  assert.equal(JSON.stringify(frozen).includes('alpha'), false);
  let modelCalls = 0;
  const destinations = [];
  for (const order of [false, true]) {
    reverse = order;
    const replay = await runScenario(frozen, { driver, reporter: { async emit() {} },
      llm: { id: 'forbidden-collection-replay', async complete() { modelCalls++; throw new Error('Replay called a model'); } } });
    assert.equal(replay.result.verdict.passed, true, JSON.stringify(replay.result));
    const destination = (await driver.observe()).execution.finalUrl;
    assert.equal(destination, `${baseUrl}/done/${order ? 'beta' : 'alpha'}`);
    destinations.push(destination.split('/').at(-1));
  }
  assert.equal(modelCalls, 0);
  assert.deepEqual(frozen.steps[1].target, declaration, 'Replay preserves the frozen declaration');
  console.log(JSON.stringify({ realAccessibility: true, collectionMembers: observation.items.length,
    hostAndNestedExcluded: true, refused, positiveAriaCoverage: true, unprovenCoverageRefused: true,
    unnamedScopedActions: true, nativeListboxes: true, customSelectRefusedBeforeOpening: true,
    nativeSelectFill: true, shadowScopeBoundary: true,
    frozenRunRelativeDestinations: destinations, replayModelCalls: modelCalls }, null, 2));
} finally {
  await driver.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
