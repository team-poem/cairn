// Real Chrome/MCP run-relative identity checks. Local fixture only; no model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ChromeDevToolsDriver, runScenario, selectedItemEquals } from '../packages/harness/dist/index.js';

let variant = 'first-A';
const resources = new Map([
  ['A', { id: 'A', title: 'Alpha resource' }],
  ['B', { id: 'B', title: 'Beta resource' }],
  ['C', { id: 'C', title: 'Unrelated resource' }],
]);
let resourceRequests = [];
// Both SPA and full-document detail views derive identity only from the API response.
const detailLoader = `async function loadDetail(resourceId) {
  const response = await fetch('/api/resources/' + encodeURIComponent(resourceId));
  if (!response.ok) throw new Error('resource request failed');
  const resource = await response.json();
  const detail = document.querySelector('#detail');
  detail.dataset.resourceId = resource.id;
  detail.textContent = resource.title;
  document.querySelector('#detail-heading').textContent = 'Details loaded';
}`;
const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url, 'http://fixture.local');
  if (url.pathname.startsWith('/api/resources/')) {
    const requestedId = decodeURIComponent(url.pathname.slice('/api/resources/'.length));
    const actualId = variant === 'wrong-detail' && requestedId === 'B' ? 'C' : requestedId;
    const resource = resources.get(actualId);
    resourceRequests.push({ requestedId, returnedId: resource?.id });
    res.setHeader('Content-Type', 'application/json');
    // Exercise awaited readiness instead of relying on a synchronous click handler.
    setTimeout(() => {
      res.statusCode = resource ? 200 : 404;
      res.end(JSON.stringify(resource ?? { error: 'resource not found' }));
    }, 80);
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  if (url.pathname.startsWith('/full-detail/')) {
    const resourceId = url.pathname.slice('/full-detail/'.length);
    res.end(`<!doctype html><title>Detail</title><h1 id="detail-heading">Loading detail</h1>
      <div id="detail"></div><script>${detailLoader}
      loadDetail(${JSON.stringify(resourceId)}).catch(error => console.error(error));</script>`);
    return;
  }
  const first = variant === 'first-A' ? 'A' : 'B';
  const next = first === 'A' ? 'B' : 'A';
  res.end(`<!doctype html><html><title>Selected item fixture</title><body>
    <div role="list" aria-label="Results">
      <div role="listitem" id="resource-0" ${variant === 'missing-key' ? '' : `data-resource-id="${first}"`}><button data-route-id="${first}">Open</button></div>
      <div role="listitem" id="resource-1" data-resource-id="${next}"><button data-route-id="${next}">Open</button></div>
    </div><h1 id="detail-heading">No detail loaded</h1><div id="detail"></div><div id="external"></div>
    <script>
      const variant = ${JSON.stringify(variant)};
      ${detailLoader}
      document.querySelectorAll('button').forEach(button => {
        button.addEventListener('pointerdown', () => {
          if (variant === 'changed-before-click') button.parentElement.dataset.resourceId = 'C';
          if (variant === 'attach-shadow') button.parentElement.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>';
          if (variant === 'reverted-incoming-owns') {
            const owner = document.querySelector('#external');
            owner.setAttribute('aria-owns', button.parentElement.id);
            owner.removeAttribute('aria-owns');
          }
        });
        button.addEventListener('click', async () => {
          const routeId = button.dataset.routeId;
          if (variant === 'full-navigation') { location.href = '/full-detail/' + routeId; return; }
          if (variant === 'new-tab') { window.open('/full-detail/' + routeId, '_blank'); return; }
          try {
            await loadDetail(routeId);
            history.pushState({}, '', '/detail/' + routeId);
          } catch (error) { console.error(error); }
        });
      });
    </script></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const steps = [
  { kind: 'goto', url: `${base}/list` },
  { kind: 'click', target: { collection: {
    root: { role: 'list', name: 'Results' }, itemRole: 'listitem', target: { role: 'button', name: 'Open' },
    order: 'dom', index: 0, expectedCount: 2,
  } }, expect: { role: 'heading', text: 'Details loaded' } },
];
const binding = { version: 1, id: 'opened-resource', relation: 'resource-key-equals', phase: 'replay',
  source: { after: steps, key: { kind: 'attribute', scope: 'item', attribute: 'data-resource-id' } },
  destination: { after: steps, key: { kind: 'attribute', selector: '#detail', attribute: 'data-resource-id' } },
};
const scenario = { name: 'open current first result and verify its detail', steps, assertions: [
  { kind: 'custom', name: 'selected-item-equals', params: binding },
  { kind: 'navigated' },
] };
const flags = ['--isolated', '--headless', '--no-page-id-routing', '--no-usage-statistics'];
const transport = process.env.CAIRN_MCP_ENTRY
  ? { command: process.execPath, args: [process.env.CAIRN_MCP_ENTRY, ...flags] }
  : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] };
try {
  for (variant of ['first-A', 'first-B', 'wrong-detail', 'missing-key', 'changed-before-click',
    'attach-shadow', 'reverted-incoming-owns', 'full-navigation', 'new-tab', 'capture-disabled']) {
    resourceRequests = [];
    const driver = new ChromeDevToolsDriver(transport);
    try {
      const { result } = await runScenario(scenario, { driver, reporter: { async emit() {} },
        judgmentKey: 'selected-item-equals-fixture-v1',
        selectedItemEvidence: variant === 'capture-disabled' ? undefined
          : { bindings: [binding], ...(variant === 'first-A' ? {} : { timeoutMs: 15_000 }) },
        custom: { 'selected-item-equals': selectedItemEquals },
        llm: { id: 'forbidden', async complete() { throw new Error('replay must be model-free'); } },
      });
      assert.equal(result.evidence.execution.actions[1].ok, true, JSON.stringify(result));
      assert.equal(result.verdict.results[1].passed, true, JSON.stringify(result));
      const positive = variant === 'first-A' || variant === 'first-B';
      assert.equal(result.verdict.passed, positive, JSON.stringify(result));
      assert.equal(result.usage.llmCalls, 0);
      const check = result.verdict.results[0];
      if (!positive && variant !== 'wrong-detail') assert.equal(check.reason, 'inconclusive', JSON.stringify(result));
      if (variant === 'wrong-detail') assert.equal(check.reason, undefined, JSON.stringify(result));
      const requestedId = variant === 'first-A' ? 'A' : 'B';
      const returnedId = variant === 'wrong-detail' ? 'C' : requestedId;
      assert.deepEqual(resourceRequests, [{ requestedId, returnedId }], `${variant}: detail request must occur exactly once`);
      // A popup can finish its initial request before the driver starts observing that page.
      // It is an unsupported binding flow, so verify cleanup and the server's exact count below;
      // same-document flows must also retain the independent request in engine evidence.
      if (variant !== 'new-tab') assert.equal(
        result.evidence.logic.requests.filter(request => request.url.includes('/api/resources/')).length, 1,
        `${variant}: independent detail request must be present in engine evidence`);
      if (variant === 'new-tab') {
        // Diagnostics only, after the public replay has finished. Never alter dispatch or guards.
        const pages = await driver.call('list_pages');
        const lines = pages.split('\n');
        const source = lines.find(line => line.includes(`${base}/list`));
        const current = lines.find(line => line.includes('[selected]'));
        assert.ok(source && current, 'source and selected detail tabs must still be available');
        const sourceId = Number(source.match(/^\s*(\d+):/)[1]);
        const currentId = Number(current.match(/^\s*(\d+):/)[1]);
        assert.notEqual(sourceId, currentId, 'the click must actually open and follow a different tab');
        try {
          await driver.call('select_page', { pageId: sourceId });
          const cleaned = await driver.call('evaluate_script', { function: `() => ({
            receiptCount: Object.getOwnPropertySymbols(globalThis)
              .filter(symbol => symbol.description?.startsWith('cairn-selected-item:')).length,
          })` });
          assert.match(cleaned, /"receiptCount"\s*:\s*0/, 'original tab must retain no selected-item receipts');
        } finally { await driver.call('select_page', { pageId: currentId }); }
      }
      console.log(`${variant}: one API request ${requestedId}->${returnedId}, equality ${positive ? 'passed' : variant === 'wrong-detail' ? 'failed' : 'inconclusive'}, 0 model calls`);
    } finally { await driver.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
