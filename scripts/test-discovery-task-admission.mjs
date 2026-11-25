// Build first. Runs against real, isolated Chrome using a cached chrome-devtools-mcp@1.8.0.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ChromeDevToolsDriver, discover, discoverWithTasks } from '../packages/harness/dist/index.js';

const fixtures = {
  '/documents': `<!doctype html><title>Documents</title>
    <h1>Document A</h1><label><input type="checkbox" checked>Ready</label><button>Confirm</button><h2>Unconfirmed</h2>
    <script>
      window.visits = [];
      document.querySelector('button').onclick = () => {
        const heading = document.querySelector('h1');
        visits.push(heading.textContent);
        document.querySelector('h2').textContent = 'Confirmed ' + heading.textContent;
        heading.textContent = 'Document B';
      };
    </script>`,
  '/ready': `<!doctype html><title>Ready</title>
    <label><input type="checkbox" id="ready" checked>Ready</label>
    <button onclick="visits.push(document.getElementById('ready').checked)">Continue</button>
    <script>window.visits = []</script>`,
  '/members': `<!doctype html><title>Members</title>
    <button id="open" data-member="A" onclick="visits.push(this.dataset.member)">Open A</button>
    <div id="host"></div><script>
      window.visits = [];
      if (new URLSearchParams(location.search).has('legacy')) {
        const aux = document.createElement('button');
        aux.textContent = 'Aux';
        document.getElementById('host').attachShadow({ mode: 'closed' }).append(aux);
      }
    </script>`,
};
const server = createServer((req, res) => {
  const html = fixtures[new URL(req.url, 'http://127.0.0.1').pathname];
  if (!html) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const flags = ['--isolated', '--headless', '--no-page-id-routing', '--no-usage-statistics', '--no-performance-crux'];
const driver = new ChromeDevToolsDriver(process.env.CAIRN_MCP_ENTRY
  ? { command: process.execPath, args: [process.env.CAIRN_MCP_ENTRY, ...flags] }
  : { command: 'npx', args: ['--offline', '-y', 'chrome-devtools-mcp@1.8.0', ...flags] });

async function evaluate(fn) {
  const reply = await driver.call('evaluate_script', { function: fn }, 'observation');
  return JSON.parse(reply.match(/```json\s*([\s\S]*?)\s*```/)[1]);
}
function scripted(decide) {
  return { id: 'scripted-admission-test', async complete(prompt) {
    if (prompt.includes('Propose the verification assertions.')) return '[]';
    assert.match(prompt, /What is the single next action\?/);
    return JSON.stringify(await decide(prompt));
  } };
}
function clickDecision(prompt, name, useRef, expectRef = true) {
  const row = prompt.split('\n').find(line => line.includes(`[button] ${name}`));
  assert.ok(row, `missing button in the decision observation: ${name}`);
  const ref = row.match(/ref="([^"]+)"/)?.[1];
  assert.equal(Boolean(ref), expectRef, `unexpected reference availability for ${name}`);
  return useRef ? { action: 'click', ref } : { action: 'click', role: 'button', text: name };
}
function guidance(name, prerequisites) {
  return {
    pageGuidanceScope: { target: { role: 'button', name }, prerequisites },
    pageGuidance: () => ({ text: `Use ${name} for the current task.`, freshness: 'declared-scope' }),
  };
}
async function checkClicks(scenario, expected, label) {
  assert.deepEqual(await evaluate('() => window.visits'), expected, `${label}: browser clicks`);
  assert.equal(scenario.steps.filter(s => s.kind === 'click').length, expected.length, `${label}: recorded clicks`);
}

async function documents(scoped, stale) {
  const label = `documents/scoped=${scoped}/stale=${stale}`;
  let turns = 0;
  const { scenario, progress } = await discoverWithTasks('Confirm document A, then document B', {
    driver, baseUrl: `${origin}/documents?case=${encodeURIComponent(label)}`, maxSteps: 2,
    ...(scoped ? guidance('Confirm', [{ role: 'checkbox', name: 'Ready' }]) : {}),
    llm: scripted(async prompt => {
      const doc = ++turns === 1 ? 'A' : 'B';
      assert.match(prompt, new RegExp(`\\[heading\\] Document ${doc}\\b`));
      const decision = clickDecision(prompt, 'Confirm', !scoped);
      if (turns === 2 && stale) {
        // The button and its scope stay identical. Only the task's current document changed.
        await evaluate("() => document.querySelector('h1').textContent = 'Document A'");
      }
      return decision;
    }),
    taskPlan: {
      tasks: ['A', 'B'].map(id => ({ id, instruction: `Confirm Document ${id}` })),
      ordered: true, onFailure: 'stop',
      match(d, { elements }) {
        if (d.action === 'click' && d.text === 'Confirm')
          return ['A', 'B'].find(id => elements.some(e => e.role === 'heading' && e.name === 'Document ' + id));
      },
      assess(id, _step, { elements }) {
        const ok = elements.some(e => e.role === 'heading' && e.name === 'Confirmed Document ' + id);
        return { route: ok ? 'completed' : 'unavailable', verification: ok ? 'passed' : 'failed' };
      },
    },
  });
  assert.equal(turns, 2);
  await checkClicks(scenario, stale ? ['Document A'] : ['Document A', 'Document B'], label);
  assert.deepEqual(progress.completed, stale ? ['A'] : ['A', 'B']);
}

async function ready(taskMode, useRef, flip) {
  const label = `ready/tasks=${taskMode}/ref=${useRef}/flip=${flip}`;
  let decisions = 0;
  const options = {
    driver, baseUrl: `${origin}/ready?case=${encodeURIComponent(label)}`, maxSteps: 1,
    ...guidance('Continue', [{ role: 'checkbox', name: 'Ready' }]),
    llm: scripted(async prompt => {
      decisions++;
      const decision = clickDecision(prompt, 'Continue', useRef);
      if (flip) await evaluate("() => document.getElementById('ready').checked = false");
      return decision;
    }),
  };
  const intent = 'Continue while Ready is checked';
  const scenario = taskMode ? (await discoverWithTasks(intent, { ...options, taskPlan: {
    tasks: [{ id: 'continue', instruction: intent }], onFailure: 'stop',
    // Deliberately do not check Ready here: the declared scope must enforce its own prerequisite.
    match: d => d.action === 'click' && d.text === 'Continue' ? 'continue' : undefined,
    assess: () => ({ route: 'completed', verification: 'unknown' }),
  } })).scenario : await discover(intent, options);
  assert.equal(decisions, 1);
  await checkClicks(scenario, flip ? [] : [true], label);
}

async function replaced(legacy, sameName) {
  const label = `members/legacy=${legacy}/same-name=${sameName}`;
  let replacements = 0;
  const { scenario, progress } = await discoverWithTasks('Open only member A', {
    driver, baseUrl: `${origin}/members?case=${encodeURIComponent(label)}${legacy ? '&legacy' : ''}`, maxSteps: 1,
    llm: scripted(async prompt => {
      // A closed shadow tree makes Chrome omit refs. Exercise its real role/name fallback.
      const decision = clickDecision(prompt, 'Open A', !legacy, !legacy);
      await evaluate(`() => {
        const old = document.getElementById('open');
        const next = old.cloneNode(true);
        next.dataset.member = 'B';
        next.textContent = ${JSON.stringify(sameName ? 'Open A' : 'Open Archived B')};
        old.replaceWith(next);
        return true;
      }`);
      replacements++;
      return decision;
    }),
    taskPlan: {
      tasks: [{ id: 'A', instruction: 'Open member A' }], onFailure: 'stop',
      match: d => d.action === 'click' && d.text === 'Open A' ? 'A' : undefined,
      assess: () => ({ route: 'completed', verification: 'unknown' }),
    },
  });
  assert.equal(replacements, 1);
  await checkClicks(scenario, [], label);
  assert.deepEqual(progress.completed, []);
}

try {
  for (const scoped of [false, true]) {
    await documents(scoped, false);
    await documents(scoped, true);
  }
  for (const flip of [false, true]) {
    await ready(false, false, flip); // ordinary discovery keeps its named scoped-click contract
    await ready(true, false, flip);
    await ready(true, true, flip);
  }
  await replaced(false, false);
  await replaced(true, false);
  await replaced(false, true); // the new button has an identical AX row but is not the original ref
  console.log('Task admission: 13 Chrome cases passed.');
} finally {
  try { await driver.close(); } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
