// Real MCP measurement + AX capture + loop lifecycle; model replies are scripted, not a benchmark.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ChromeDevToolsDriver, createHostOwnedRootScope, createScrollNoProgressPolicy, discover, explore, runScenario, startTrace } from '../packages/harness/dist/index.js';

// The recovery action stays visible: offscreen geometry remains subject to existing host guards.
const html = '<!doctype html><title>Scroll fixture</title><style>body{margin:0}main{height:2400px}button{position:fixed;bottom:20px;left:20px}aside{position:fixed;right:0;top:0}</style><main><h1>Application</h1><button onclick="location.href=\'/done\'">Continue</button></main><aside id="host">Host panel</aside>';
const server = createServer((req, res) => {
  if (req.url === '/lazy' || req.url === '/lazy-fail') {
    setTimeout(() => { res.writeHead(req.url === '/lazy-fail' ? 500 : 200, { 'Content-Type': 'text/plain' }); res.end('Loaded target'); }, 80);
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(req.url === '/done' ? '<!doctype html><title>Done</title><h1>Goal reached</h1>' : html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const flags = ['--isolated', '--headless', '--viewport=800x600', '--no-page-id-routing', '--no-usage-statistics'];
const transport = process.env.CAIRN_MCP_ENTRY
  ? { command: process.execPath, args: [process.env.CAIRN_MCP_ENTRY, ...flags] }
  : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] };
const hostOwnedRoots = createHostOwnedRootScope();
const driver = new ChromeDevToolsDriver({ ...transport, hostOwnedRoots, settle: { idleMs: 50, pollMs: 25, timeoutMs: 500 } });
const evaluate = body => driver.call('evaluate_script', { function: `() => { ${body} }` });
const policy = createScrollNoProgressPolicy({ tolerance: 2 });
async function prepare() {
  await driver.goto(baseUrl);
  await evaluate(`(${hostOwnedRoots.registerScript})(document.getElementById('host')); return {};`);
}
try {
  await prepare();
  assert.ok(await driver.scrollState(), 'actual MCP supplies measured coverage');
  let decisions = 0;
  const cycle = await discover('Find an unavailable destination', { driver, policy, maxSteps: 12,
    llm: { id: 'scripted', async complete() {
      // Host-only semantic churn must not be interpreted as application progress.
      await evaluate(`document.getElementById('host').textContent = 'Host cycle ${++decisions}'; return {};`);
      // Repeat the known B->A transition after detection. An untried B->C direction is now
      // intentionally allowed as a recovery probe and must not be mistaken for this cycle.
      return JSON.stringify({ action: decisions > 6 ? 'done' : 'scroll', direction: decisions === 1 || decisions === 3 ? 'down' : 'up' });
    } },
  });
  assert.equal(cycle.truncated, true);
  assert.equal(cycle.truncationReason, 'no-progress');
  assert.ok(decisions < 12);

  await prepare();
  let turn = 0;
  const events = [];
  const trace = startTrace({ emit: event => events.push(event) }, 'test').scope('recovery');
  const recovered = await discover('Reach the goal', { driver, policy, maxSteps: 12,
    trace,
    llm: { id: 'scripted', async complete() {
      turn++;
      if (turn < 4) return JSON.stringify({ action: 'scroll', direction: turn % 2 ? 'down' : 'up' });
      if (turn === 4) return JSON.stringify({ action: 'click', text: 'Continue' });
      if (turn === 5) return JSON.stringify({ action: 'done', assertions: [{ kind: 'navigated', to: '/done' }] });
      return '[]'; // freeze assertion proposal
    } },
  });
  assert.notEqual(recovered.truncated, true, JSON.stringify(events.filter(e => ['action', 'gate'].includes(e.kind))));
  const replay = { ...recovered, steps: [{ kind: 'goto', url: baseUrl }, ...recovered.steps] };
  const result = await runScenario(replay, { driver });
  assert.equal(result.result.verdict.passed, true, 'recovery freezes a deterministic replayable path');

  await prepare();
  await evaluate(`const shadow = document.createElement('div'); document.querySelector('main').append(shadow);
    shadow.attachShadow({mode:'closed'}).innerHTML = '<div style="height:100px;overflow:auto"><div style="height:2000px"><button>Closed target</button></div></div>'; return {};`);
  assert.match(await driver.call('take_snapshot', { verbose: true }), /Closed target/, 'real AX exposes the closed-tree target');
  assert.equal(await driver.scrollState(), undefined, 'closed AX descendants cannot claim document coverage');
  await prepare();
  await evaluate(`document.documentElement.style.overflow = 'hidden'; document.body.style.cssText = 'height:100vh;overflow:auto;margin:0'; return {};`);
  assert.equal(await driver.scrollState(), undefined, 'body-owned scroller is not window coverage');

  await prepare();
  await evaluate('window.scrollTo(0, document.scrollingElement.scrollHeight); return {};');
  const lazyPolicy = policy.createRun();
  const observePolicy = async () => {
    const elements = await driver.snapshot({ perception: true });
    const scroll = await driver.scrollState();
    assert.ok(scroll);
    const ctx = { elements, scroll, url: baseUrl };
    lazyPolicy.observe(ctx);
    return ctx;
  };
  let ctx = await observePolicy();
  for (let i = 0; i < 2; i++) {
    await driver.scroll('down'); lazyPolicy.executed({ kind: 'scroll', direction: 'down' }, ctx);
    ctx = await observePolicy();
  }
  assert.equal(lazyPolicy.incomplete()?.diagnostic.code, 'no-progress');
  // Actual asynchronous network response adds content after suspicion, not a static state swap.
  await evaluate(`return fetch('/lazy').then(r => r.text()).then(text => {
    const button = document.createElement('button'); button.textContent = text; document.querySelector('main').append(button); return {};
  });`);
  ctx = await observePolicy();
  assert.ok(ctx.elements.some(e => e.name === 'Loaded target'));
  assert.equal(lazyPolicy.incomplete(), undefined, 'late content permits recovery');

  await prepare();
  await evaluate(`window.addEventListener('scroll', () => {
    fetch('/lazy-fail').then(() => console.error('Lazy request failed after scroll'));
  }, { once: true }); return {};`);
  let errorTurn = 0;
  const errors = await explore('Inspect the scroll result', { driver, baseUrl, policy,
    // Explore navigates at entry, so re-install the app listener before its first action.
    llm: { id: 'scripted', async complete() {
      errorTurn++;
      if (errorTurn === 1) await evaluate(`window.addEventListener('scroll', () => {
        fetch('/lazy-fail').then(() => console.error('Lazy request failed after scroll'));
      }, { once: true }); return {};`);
      return JSON.stringify(errorTurn < 4 ? { action: 'scroll', direction: errorTurn % 2 ? 'down' : 'up' } : { action: 'done' });
    } },
  });
  assert.equal(errors.truncationReason, 'no-progress');
  assert.ok(errors.findings.some(f => f.kind === 'failed-request' && f.detail.includes('500')));
  assert.ok(errors.findings.some(f => f.kind === 'console-error' && f.detail.includes('Lazy request failed after scroll')));
  console.log(JSON.stringify({ cycle: cycle.truncationReason, recovered: true, replay: 'passed (no model supplied)',
    closedShadow: 'unsupported', bodyScroller: 'unsupported', asyncLazyRecovery: true, scrollErrorsPreserved: true }));
} finally { await driver.close(); await new Promise(resolve => server.close(resolve)); }
