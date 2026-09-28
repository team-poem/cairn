// #246: public Driver adaptation, real Chrome, scripted decisions; no hosted model needed.
// npm run build && node bench/local/reference-free.mjs [report.json]
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { startFixture, reservePort } from './server.mjs';
import { ChromeDevToolsDriver, discover, explore, LlmStepHealer, runScenario } from '../../packages/harness/dist/index.js';

const mcp = process.env.CAIRN_MCP_ENTRY;
const flags = ['--isolated', '--headless', '--no-page-id-routing', '--no-usage-statistics'];
const options = mcp ? { command: process.execPath, args: [mcp, ...flags] }
  : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] };
const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const report = [];
let frozen;
for (const phase of ['discover', 'explore', 'step-heal', 'replay']) {
  const fixture = await startFixture({ tier: 'form', version: 'v1', runIndex: 0,
    latency: { document: [0], api: [0] }, port });
  const chrome = new ChromeDevToolsDriver(options);
  // A legacy adapter omits the optional exact-node capability and returns ordinary snapshots.
  // Every interaction still uses the real driver's trusted input and public methods.
  const driver = new Proxy(chrome, { get(target, key) {
    if (key === 'locateRef') return undefined;
    if (key === 'snapshot') return () => target.snapshot();
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  let decisions = 0;
  let completions = 0;
  const llm = { id: 'scripted-reference-free', async complete(prompt, opts) {
    completions++;
    assert.notEqual(phase, 'replay', 'Frozen replay must not call a model');
    if (prompt.includes('Propose the verification assertions.')) {
      return '[{"kind":"request-status","urlIncludes":"/api/save","method":"POST","status":200}]';
    }
    decisions++;
    assert.match(opts.system, /No references are available in this observation/);
    assert.ok(!opts.system.includes('"ref":"<ref>"'));
    assert.ok(!prompt.includes('Current observation references'));
    if (phase === 'step-heal') return '{"action":"click","text":"Save","role":"button"}';
    return decisions === 1 ? '{"action":"type","text":"Name","role":"textbox","value":"alice"}'
      : decisions === 2 ? '{"action":"click","text":"Save","role":"button"}' : '{"action":"done"}';
  } };
  try {
    if (phase === 'discover') {
      frozen = await discover('Enter alice in Name and save it', { driver, llm, baseUrl: origin, maxSteps: 4 });
      assert.ok(!frozen.truncated);
      assert.equal(decisions, 3);
      assert.ok(frozen.assertions.some(a => a.kind === 'request-status' && a.method === 'POST' && a.status === 200));
      assert.ok(!JSON.stringify(frozen).includes('"ref"'));
    } else if (phase === 'explore') {
      const result = await explore('Enter alice in Name and save it', { driver, llm, baseUrl: origin, maxSteps: 4 });
      assert.ok(!result.truncated);
      assert.equal(decisions, 3);
    } else if (phase === 'step-heal') {
      await driver.goto(origin);
      await driver.type({ text: 'Name', role: 'textbox' }, 'alice');
      const step = { kind: 'click', target: { text: 'Old save' }, intent: 'Save the name',
        expect: { requestStatus: { urlIncludes: '/api/save', method: 'POST', status: 200 } } };
      const result = await new LlmStepHealer(llm).heal(step, 0, driver);
      assert.ok(result);
      assert.deepEqual(result.step.expect, step.expect);
      assert.equal(decisions, 1);
    } else {
      const result = await runScenario(frozen, { driver, llm, reporter: { async emit() {} } });
      assert.equal(result.result.verdict.passed, true, JSON.stringify(result.result));
      assert.equal(result.result.verdict.proof.grade, 'work');
      assert.equal(result.result.usage.llmCalls, 0);
      assert.equal(completions, 0);
    }
    await driver.settle();
    const evidence = await driver.observe();
    assert.ok(evidence.logic.requests.some(r => r.method === 'POST' && r.url.endsWith('/api/save') && r.status === 200));
    assert.equal(fixture.snapshot().complete, true);
    report.push({ phase, decisions, completions, oracle: fixture.snapshot() });
  } finally { await chrome.close(); await fixture.close(); }
}
console.log(JSON.stringify(report, null, 2));
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
