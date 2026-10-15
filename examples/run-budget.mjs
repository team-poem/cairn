// npm run build && node examples/run-budget.mjs
// Real Chrome + local fixture + scripted model; no keys or paid requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { runSuite, stepError } from '../packages/harness/dist/index.js';

let label = 'Checkout';
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(req.url === '/done' ? '<h1>Order complete</h1>' :
    `<h1>Checkout fixture</h1><button onclick="location.href='/done'">${label}</button>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
  for (const maxModelCalls of [3, 4]) {
    label = 'Checkout';
    let drivers = 0;
    let closed = 0;
    let clicks = 0;
    let calls = 0;
    const frozen = [];
    const events = [];
    const replies = [
      '{"action":"click","text":"Checkout","role":"button"}',
      '{"action":"done"}',
      '[]', // assertion proposals; navigation is also derived from live evidence
      '{"name":"Complete order","role":"button"}', // locator repair during fresh replay
    ];
    // This adapter only supports the fixture's verbs. Its clicks use real browser input.
    const driverFactory = () => {
      if (++drivers === 2) label = 'Complete order'; // UI changes after discovery, before replay
      const pageReady = browser.newPage();
      const unsupported = async () => { throw new Error('Unexpected fixture action'); };
      return {
        async goto(url) { await (await pageReady).goto(url); },
        async click(target) {
          const page = await pageReady;
          const button = page.getByRole(target.role ?? 'button', { name: target.text, exact: true });
          if (!await button.count()) throw stepError('resolution', 'Control renamed');
          await Promise.all([page.waitForURL(`${origin}/done`), button.click()]);
          clicks++;
        },
        async locate(target) { return target; },
        async snapshot() {
          return (await pageReady).locator('button').evaluateAll(nodes =>
            nodes.map(node => ({ role: 'button', name: node.textContent })));
        },
        async settle() { await (await pageReady).locator('h1').waitFor(); },
        async observe() {
          return { execution: { actions: [], navigated: true, blocked: false, finalUrl: (await pageReady).url() },
            perception: {}, logic: { requests: [], console: [] } };
        },
        async screenshot() { return undefined; },
        async close() { await (await pageReady).close(); closed++; },
        doubleClick: unsupported, hover: unsupported, type: unsupported, select: unsupported,
        pressKey: unsupported, scroll: unsupported,
      };
    };
    const result = await runSuite([{ id: 'checkout', intent: 'Complete checkout', url: origin,
      assertions: [{ kind: 'navigated', to: `${origin}/done` }] }], {
      budget: { maxModelCalls, timeoutMs: 30_000 }, driverFactory,
      llm: { id: 'scripted-not-a-quality-benchmark', async complete() {
        assert.ok(calls < replies.length, 'Unexpected extra model request');
        return replies[calls++];
      } },
      reporter: { async emit() {} },
      trace: { emit: event => events.push(event) },
      store: {
        async load() { throw new Error('Empty fixture cache'); },
        async freeze(ref, scenario) { frozen.push(structuredClone(scenario)); return ref; },
      },
    });
    const verdict = result.verdicts[0].verdict;
    assert.equal(calls, maxModelCalls);
    assert.equal(result.usage.llmCalls, maxModelCalls);
    assert.equal(closed, 2);
    assert.equal(events.filter(e => e.kind === 'case-end').length, 1);
    if (maxModelCalls === 3) {
      assert.equal(verdict.failure, 'budget');
      assert.equal(verdict.budget.phase, 'locator-heal');
      assert.equal(frozen.length, 1, 'Only completed discovery may persist, never an interrupted repair');
      assert.equal(clicks, 1, 'Exhaustion must not dispatch the repaired click');
      console.log('3-call budget:', JSON.stringify(verdict.budget));
    } else {
      assert.equal(verdict.passed, true, JSON.stringify(verdict));
      assert.equal(frozen.length, 2);
      assert.deepEqual(frozen[1].assertions, frozen[0].assertions);
      assert.equal(clicks, 2);
      console.log('4-call budget: discovery + locator repair passed, original assertions preserved');
    }
  }
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
