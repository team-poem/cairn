// Build first. The scripted model proposes clicks; the real page counts trusted input events.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpointEvidence, ChromeDevToolsDriver, discoverForReplayCleanup, identifyScenario, loadSkillFile, prepareReplayCleanup, runScenario, saveSkillFile }
  from '../packages/harness/dist/index.js';

const server = createServer((req, res) => {
  if (req.url !== '/review') { res.writeHead(204).end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(`<!doctype html>
    <title>Document review</title><h1>Review</h1><button>Show summary</button><h2 hidden>Summary</h2>
    <script>
      window.clicks = 0;
      window.opened = 0;
      document.querySelector('button').onclick = event => {
        if (event.isTrusted) window.clicks++;
        if (event.isTrusted && document.querySelector('h2').hidden) window.opened++;
        document.querySelector('h2').hidden = false;
      };
    </script>`);
});
const flags = ['--isolated', '--headless', '--no-page-id-routing', '--no-usage-statistics', '--no-performance-crux'];
const transport = process.env.CAIRN_MCP_ENTRY
  ? { command: process.execPath, args: [process.env.CAIRN_MCP_ENTRY, ...flags] }
  : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] };
async function withBrowser(run) {
  const driver = new ChromeDevToolsDriver(transport);
  try { return await run(driver); } finally { await driver.close(); }
}
async function assertPage(driver, clicks, opened = 1) {
  const reply = await driver.call('evaluate_script', { function: `() => ({ clicks: window.clicks, opened: window.opened,
    visible: document.querySelector('h2').getClientRects().length > 0 })` }, 'observation');
  const json = reply.match(/```json\s*([\s\S]*?)\s*```/);
  assert.ok(json, 'Expected the fixture state measured in Chrome');
  assert.deepEqual(JSON.parse(json[1]), { clicks, opened, visible: true });
}

const directory = await mkdtemp(join(tmpdir(), 'cairn-replay-cleanup-'));
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/review`;
  const discoverPanel = (resetWhileDeciding = false) => withBrowser(async driver => {
    let decisions = 0;
    const result = await discoverForReplayCleanup('Show the review summary', { baseUrl, driver, maxSteps: 3,
      llm: { id: 'scripted-summary', async complete(prompt) {
        if (prompt.includes('Propose the verification assertions.')) return '[]';
        if (++decisions === 3) return '{"action":"done"}';
        // A local UI update after observation. Neither the URL nor the network log changes.
        if (resetWhileDeciding && decisions === 2)
          await driver.call('evaluate_script', { function: "() => { document.querySelector('h2').hidden = true; }" }, 'observation');
        const row = prompt.split('\n').find(line => line.includes('[button] Show summary') && line.includes('ref="'));
        assert.ok(row, 'Expected the visible summary button in the current observation');
        return JSON.stringify({ action: 'click', ref: row.match(/ref="([^"]+)"/)[1] });
      } },
    });
    await assertPage(driver, 2, resetWhileDeciding ? 2 : 1);
    return result;
  });
  const { scenario, recording } = await discoverPanel();
  assert.deepEqual(scenario.steps.map(s => s.kind), ['goto', 'click', 'click']);
  assert.equal(recording.status, 'recorded', JSON.stringify(recording));
  const target = scenario.steps[2].target;
  assert.equal(target.role, 'button');
  assert.equal(target.text, 'Show summary');
  const declaration = { revision: 'display-summary-v1', scope: 'review', semantics: 'idempotent-click', target, repeatIndex: 2 };
  // The URL does not change. Persist the requirement to see the Summary heading after the
  // retained click; a green final URL or a click count alone does not show the view opened.
  const point = { id: 'summary', after: scenario.steps.slice(0, 2) };
  const judgmentKey = 'summary-heading-v1';
  const original = await identifyScenario({ ...scenario, assertions: [...scenario.assertions,
    { kind: 'custom', name: 'summary-visible', params: point } ] }, { intent: scenario.name, judgmentKey });
  const approval = await prepareReplayCleanup(original, recording, declaration);
  assert.equal(approval.status, 'approved', JSON.stringify(approval));
  const path = join(directory, 'review.skill.json');
  await saveSkillFile(path, original);
  const loaded = await loadSkillFile(path);
  assert.equal((await prepareReplayCleanup(loaded, recording)).status, 'declined');
  for (const useApproval of [false, true]) {
    await withBrowser(async driver => {
      const { result } = await runScenario(loaded, { driver, reporter: { async emit() {} },
        llm: { id: 'forbidden', async complete() { throw new Error('replay called a model'); } },
        judgmentKey, evidenceCapture: { checkpoints: [{ ...point, elements: true }] },
        custom: { 'summary-visible': async (params, evidence) => {
          const checkpoint = await checkpointEvidence(evidence, params);
          return checkpoint?.elements?.some(e => e.role === 'heading' && e.name === 'Summary') ??
            { inconclusive: true, required: true, detail: 'Missing summary checkpoint' };
        } },
        ...(useApproval && { replayCleanup: JSON.parse(JSON.stringify({ approval, declaration })) }),
      });
      assert.equal(result.verdict.passed, true, JSON.stringify(result.verdict));
      assert.equal(result.replayCleanup?.status, useApproval ? 'approved' : undefined);
      assert.equal(result.usage.llmCalls, 0);
      await assertPage(driver, useApproval ? 1 : 2);
    });
  }
  const reopened = await discoverPanel(true);
  assert.deepEqual(reopened.scenario.steps.map(s => s.kind), ['goto', 'click', 'click']);
  assert.equal(reopened.recording.status, 'unavailable', 'both clicks reopened the panel');
  console.log('Replay: 2 clicks without approval, 1 with approval, 0 model calls. When the panel closed between decisions both clicks opened it and cleanup was refused.');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
