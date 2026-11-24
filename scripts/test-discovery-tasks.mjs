// Build first, then run with Chrome and a cached chrome-devtools-mcp@1.8.0. No model account needed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ChromeDevToolsDriver, discover, discoverWithTasks, runScenario } from '../packages/harness/dist/index.js';

const ids = ['A', 'B', 'C'];
const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
  if (req.url === '/notify') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Notify</title><button>Notify</button><h1>Ready</h1><script>
      let clicks = 0;
      document.querySelector('button').onclick = () => {
        clicks++;
        alert('OK');
        document.querySelector('h1').textContent = 'Notified ' + clicks;
      };
    </script>`);
    return;
  }
  if (req.url === '/terms') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Terms</title><body style="height:400vh">
      <div style="position:fixed"><h1>Unread</h1><button>Accept terms</button></div>
      <script>
        let reviewed = false;
        addEventListener('scroll', () => {
          if (scrollY > 0) { reviewed = true; document.querySelector('h1').textContent = 'Terms reviewed'; }
        });
        document.querySelector('button').onclick = () => { if (reviewed) history.pushState(null, '', '/accepted'); };
      </script>`);
    return;
  }
  if (req.url !== '/') { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>Documents</title>
    ${ids.map(id => `<button data-id="${id}">Open ${id}</button>`).join('')}
    <h1>Choose a document</h1><section></section>
    <script>
      window.visits = [];
      document.addEventListener('click', ({target}) => {
        const id = target.dataset.id;
        if (!id) return;
        visits.push(id);
        document.querySelector('h1').textContent = 'Viewing ' + id;
        const detail = document.querySelector('section');
        detail.replaceChildren();
        if (id !== 'C') {
          const heading = detail.appendChild(document.createElement('h2'));
          heading.textContent = id === 'A' ? 'Title A' : 'Wrong title';
        }
      });
    </script>`);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const flags = ['--isolated', '--headless', '--no-page-id-routing', '--no-usage-statistics', '--no-performance-crux'];
const newDriver = () => new ChromeDevToolsDriver(process.env.CAIRN_MCP_ENTRY
  ? { command: process.execPath, args: [process.env.CAIRN_MCP_ENTRY, ...flags] }
  : { command: 'npx', args: ['--offline', '-y', 'chrome-devtools-mcp@1.8.0', ...flags] });
const driver = newDriver();
try {
  // The model declares done too early, then tries to repeat A. Only the first A may reach the page.
  const picks = ['A', 'done', 'A', 'B', 'C'];
  let turns = 0;
  const llm = { id: 'scripted-documents', async complete(prompt) {
    if (prompt.includes('Propose the verification assertions.')) return '[]';
    const pick = picks[turns++];
    assert.ok(pick, 'no further model decision is needed after C');
    if (pick === 'done') return '{"action":"done"}';
    const row = prompt.split('\n').find(line => line.includes(`[button] Open ${pick}`) && line.includes('ref='));
    const ref = row?.match(/ref="([^"]+)"/)?.[1];
    assert.ok(ref, `missing current reference for Open ${pick}`);
    return JSON.stringify({ action: 'click', ref });
  } };
  const readVisits = async () => {
    const reply = await driver.call('evaluate_script', { function: '() => window.visits' }, 'observation');
    return JSON.parse(reply.match(/```json\s*([\s\S]*?)\s*```/)[1]);
  };
  const intent = 'Open each document and check its title';
  const options = { driver, llm, baseUrl: `http://127.0.0.1:${server.address().port}/`, maxSteps: 8 };
  await discover(intent, options);
  assert.deepEqual(await readVisits(), ['A'], 'without the task plan, done still ends discovery');
  assert.equal(turns, 2);
  turns = 0;
  const { scenario, progress } = await discoverWithTasks(intent, {
    ...options,
    taskPlan: {
      tasks: ids.map(id => ({ id, instruction: `Open ${id}` })), ordered: true, onFailure: 'continue',
      match(decision) {
        return decision.action === 'click' && decision.role === 'button'
          ? ids.find(id => decision.text === `Open ${id}`) : undefined;
      },
      assess(id, _step, { elements }) {
        const headings = elements.filter(row => row.role === 'heading').map(row => row.name);
        if (!headings.includes(`Viewing ${id}`)) return { route: 'unavailable', verification: 'unknown' };
        return { route: 'completed', verification: headings.includes(`Title ${id}`) ? 'passed'
          : headings.includes('Wrong title') ? 'failed' : 'unknown' };
      },
    },
  });
  const visits = await readVisits();
  assert.deepEqual(visits, ids);
  assert.equal(turns, picks.length);
  assert.equal(progress.modelDoneCount, 1);
  assert.deepEqual(progress.completed, ids);
  assert.deepEqual(progress.remaining, []);
  assert.deepEqual(progress.tasks.map(({ route, verification }) => [route, verification]), [
    ['completed', 'passed'], ['completed', 'failed'], ['completed', 'unknown'],
  ]);
  assert.equal(progress.reason, 'task-failed');
  assert.equal(scenario.truncated, true);
  console.log(JSON.stringify({ visits, turns, progress }));

  // The button is visible even before scrolling. Its handler requires the user to have read
  // the terms: neither an unchanged URL nor a quiet network makes the approved scroll optional.
  const termsUrl = options.baseUrl + 'terms';
  const acceptedUrl = options.baseUrl + 'accepted';
  let decisions = 0;
  const terms = await discoverWithTasks('Read and accept the terms', {
    driver, baseUrl: termsUrl, llm: { id: 'scripted-terms', async complete(prompt) {
      if (prompt.includes('Propose the verification assertions.')) return '[]';
      if (++decisions === 1) return '{"action":"scroll","direction":"down"}';
      assert.equal(decisions, 2);
      const ref = prompt.split('\n').find(line => line.includes('[button] Accept terms'))?.match(/ref="([^"]+)"/)?.[1];
      assert.ok(ref);
      return JSON.stringify({ action: 'click', ref });
    } },
    taskPlan: {
      tasks: [{ id: 'review', instruction: 'Scroll down to read the terms' }, { id: 'accept', instruction: 'Accept terms' }],
      ordered: true, onFailure: 'stop',
      match: d => d.action === 'scroll' && d.direction === 'down' ? 'review' :
        d.action === 'click' && d.text === 'Accept terms' ? 'accept' : undefined,
      assess(id, _step, { elements, url }) {
        const ok = id === 'review' ? elements.some(e => e.role === 'heading' && e.name === 'Terms reviewed') : url === acceptedUrl;
        return { route: ok ? 'completed' : 'unavailable', verification: ok ? 'passed' : 'failed' };
      },
    },
  });
  assert.deepEqual(terms.progress.completed, ['review', 'accept']);
  assert.equal(terms.scenario.truncated, undefined);
  assert.deepEqual(terms.scenario.steps.map(s => s.kind), ['goto', 'scroll', 'click']);
  const replay = newDriver();
  try {
    const { result } = await runScenario(terms.scenario, { driver: replay, reporter: { async emit() {} } });
    assert.equal(result.verdict.passed, true, result.verdict.detail);
    assert.equal(result.evidence.execution.finalUrl, acceptedUrl);
    assert.equal(result.usage?.llmCalls, 0);
  } finally { await replay.close(); }

  // MCP 1.8 rejects a click blocked in alert(). Only the original event receipt can
  // acknowledge it. The heading counts actual clicks and appears after the alert closes.
  const notify = await discoverWithTasks('Notify once', {
    driver, baseUrl: options.baseUrl + 'notify', maxSteps: 1,
    llm: { id: 'scripted-alert', async complete(prompt) {
      if (prompt.includes('Propose the verification assertions.')) return '[]';
      const ref = prompt.split('\n').find(line => line.includes('[button] Notify'))?.match(/ref="([^"]+)"/)?.[1];
      assert.ok(ref);
      return JSON.stringify({ action: 'click', ref });
    } },
    taskPlan: {
      tasks: [{ id: 'notify', instruction: 'Notify once' }], onFailure: 'stop',
      match: d => d.action === 'click' && d.text === 'Notify' ? 'notify' : undefined,
      assess: (_id, _step, { elements }) => elements.some(e => e.role === 'heading' && e.name === 'Notified 1')
        ? { route: 'completed', verification: 'passed' } : { route: 'unavailable', verification: 'failed' },
    },
  });
  assert.equal(notify.progress.reason, 'tasks-complete');
  assert.deepEqual(notify.scenario.steps.map(s => s.kind), ['goto', 'click']);
  assert.equal(notify.progress.tasks[0].verification, 'passed');
} finally {
  try { await driver.close(); } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
