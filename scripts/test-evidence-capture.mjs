// Real Chrome/MCP checkpoint regression. No model, driver monkey-patch or private fixture state.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ChromeDevToolsDriver, checkpointEvidence, runScenario } from '../packages/harness/dist/index.js';

let heading = 'Editor';
let disabled = false;
const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.setHeader('Content-Type', 'text/html');
  const body = req.url === '/editor'
    ? `<h1>${heading}</h1><button ${disabled ? 'disabled' : ''}>Save draft</button><a href="/review">Review</a>`
    : req.url === '/review' ? '<h1>Review</h1><a href="/confirmation">Confirm</a>'
    : req.url === '/confirmation' ? '<h1>Confirmation</h1>' : '<a href="/editor">Edit</a>';
  res.end(`<!doctype html><html><title>Checkpoint fixture</title><body>${body}</body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const steps = [
  { kind: 'goto', url: base },
  { kind: 'click', target: { text: 'Edit', role: 'link' }, expect: { url: '/editor' } },
  { kind: 'click', target: { text: 'Review', role: 'link' }, expect: { url: '/review' } },
  { kind: 'click', target: { text: 'Confirm', role: 'link' }, expect: { url: '/confirmation' } },
];
const point = { id: 'editor', after: steps.slice(0, 2), elements: true };
const scenario = { name: 'intermediate editor verification', steps, assertions: [
  { kind: 'custom', name: 'editor', params: { after: point.after } },
  { kind: 'navigated', to: `${base}/confirmation` },
] };
const flags = ['--isolated', '--headless', '--no-page-id-routing', '--no-usage-statistics'];
const transport = process.env.CAIRN_MCP_ENTRY
  ? { command: process.execPath, args: [process.env.CAIRN_MCP_ENTRY, ...flags] }
  : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] };
try {
  for (const variant of ['positive', 'wrong-heading', 'disabled-save', 'capture-disabled']) {
    heading = variant === 'wrong-heading' ? 'Wrong editor' : 'Editor';
    disabled = variant === 'disabled-save';
    const driver = new ChromeDevToolsDriver(transport);
    try {
      const { result } = await runScenario(scenario, { driver, reporter: { async emit() {} },
        judgmentKey: 'checkpoint-fixture-v1',
        evidenceCapture: variant === 'capture-disabled' ? undefined : { checkpoints: [point], timeoutMs: 10_000 },
        llm: { id: 'forbidden', async complete() { throw new Error('replay must be model-free'); } },
        custom: { async editor(params, evidence) {
          const record = await checkpointEvidence(evidence, { id: 'editor', after: params.after });
          if (!record?.elements) return { inconclusive: true, required: true, detail: 'missing editor capture' };
          return record.elements.some(e => e.role === 'heading' && e.name === 'Editor')
            && record.elements.some(e => e.role === 'button' && e.name === 'Save draft' && e.disabled !== true);
        } },
      });
      assert.equal(result.verdict.results[1].passed, true, JSON.stringify(result));
      assert.equal(result.verdict.passed, variant === 'positive', JSON.stringify(result));
      assert.equal(result.usage.llmCalls, 0);
      if (variant === 'capture-disabled') assert.equal(result.verdict.results[0].reason, 'inconclusive');
      else assert.equal(result.evidence.checkpoints[0].status, 'captured', JSON.stringify(result));
      console.log(`${variant}: final passed, overall ${result.verdict.passed ? 'passed' : 'not passed'}, 0 model calls`);
    } finally { await driver.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
