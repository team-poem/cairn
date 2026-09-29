// #245: real Chrome scoped-secret replay, with no hosted model or private transport hooks.
// npm run build && node bench/local/secret-scope.mjs
import assert from 'node:assert/strict';
import { startFixture, reservePort } from './server.mjs';
import { ChromeDevToolsDriver, runScenario } from '../../packages/harness/dist/index.js';

const mcp = process.env.CAIRN_MCP_ENTRY;
const flags = ['--isolated', '--headless', '--no-page-id-routing', '--no-usage-statistics'];
const options = mcp ? { command: process.execPath, args: [mcp, ...flags] }
  : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] };
const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const scenario = { name: 'scoped form value', steps: [
  { kind: 'goto', url: origin },
  { kind: 'type', target: { text: 'Name', role: 'textbox' }, text: '{name}' },
  { kind: 'click', target: { text: 'Save', role: 'button' } },
], assertions: [{ kind: 'request-status', urlIncludes: '/api/save', method: 'POST', status: 200 }] };
for (const mode of ['valid', 'other-port', 'malformed']) {
  const fixture = await startFixture({ tier: 'form', version: 'v1', runIndex: 0,
    latency: { document: [0], api: [0] }, port });
  const chrome = new ChromeDevToolsDriver(options);
  let calls = 0;
  const driver = new Proxy(chrome, { get(target, key) {
    const value = target[key];
    return typeof value === 'function' ? (...args) => { calls++; return value.apply(target, args); } : value;
  } });
  const scope = mode === 'valid' ? origin : mode === 'other-port' ? 'http://127.0.0.1:1' : `127.0.0.1:${port}`;
  let llmCalls = 0;
  const llm = { id: 'forbidden', async complete() { llmCalls++; throw new Error('Replay must not call a model'); } };
  try {
    const run = () => runScenario(scenario, { driver, llm, reporter: { async emit() {} },
      secrets: { name: { value: 'alice', origin: scope } } });
    if (mode === 'malformed') {
      await assert.rejects(run, /origin could not be parsed/);
      assert.equal(calls, 0, 'Malformed scopes must fail before any driver call');
    } else {
      const { result } = await run();
      assert.equal(result.verdict.passed, mode === 'valid');
      assert.equal(result.usage.llmCalls, 0);
      assert.ok(!JSON.stringify(result).includes('alice'), 'Result must retain the placeholder');
      if (mode === 'valid') assert.equal(result.verdict.proof.grade, 'work');
      else {
        assert.equal(result.verdict.failure, 'script');
        assert.match(result.evidence.execution.actions[1].error, /refused on/);
      }
    }
    assert.equal(llmCalls, 0);
    assert.equal(fixture.snapshot().complete, mode === 'valid');
    console.log(`${mode}: passed; model calls=${llmCalls}`);
  } finally { await chrome.close(); await fixture.close(); }
}
