// Real, local Chrome/MCP contract tests. Build first. CAIRN_MCP_ENTRY can select a cached MCP 1.8.0.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ChromeDevToolsDriver, discover, explore, startTrace, runScenario } from '../packages/harness/dist/index.js';

let replayLayout = false;
const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const variant = new URL(req.url, 'http://127.0.0.1').pathname.slice(1);
  const other = '<button id="other">Keep shopping</button>';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<!doctype html><title>Cart</title><style>#twin { display: none }</style>
    <p id="promo">${variant === 'promo' ? 'Promotion "Round 0"' : 'Promotion A'}</p>
    <select aria-label="Delivery"><option value="s">Standard</option><option value="e">Express</option></select>
    <ul aria-label="Cart rows"><li><input id="row" type="checkbox" aria-label="Select row"></li></ul>
    ${variant === 'dispatch-error' ? '<button id="start">Start</button>' : ''}
    ${variant === 'ordinal' && !replayLayout ? other : ''}
    <button id="checkout">${variant === 'promo' ? '<svg aria-hidden="true" width="12" height="12"><circle cx="6" cy="6" r="5"></circle></svg><span>Checkout</span>' : 'Checkout'}</button>
    ${variant === 'promo' ? '<button id="offer">Offer "Today"</button><input type="submit" id="coupon" value="Apply coupon">' : ''}
    ${variant === 'ordinal' && replayLayout ? other : ''}
    ${variant.startsWith('css-') ? '<button id="twin">Checkout</button>' : ''}
    <script>
      document.querySelector('#row').indeterminate = ${variant === 'mixed'};
      window.cart = { clicks: [], ticks: 0, intervalTicks: 0 };
      cart.rotate = () => {
        const text = 'Promotion "Round ' + (++cart.ticks) + '"';
        document.querySelector('#promo').firstChild.data = text;
        return { tick: cart.ticks, text };
      };
      cart.start = () => {
        cart.interval = setInterval(() => { cart.intervalTicks++; cart.rotate(); }, 30);
        cart.deadline = setTimeout(cart.stop, 30_000);
      };
      cart.stop = () => {
        clearInterval(cart.interval); clearTimeout(cart.deadline); cart.interval = undefined;
      };
      document.addEventListener('click', event => {
        const button = event.target.closest('button,input[type="submit"]');
        if (!button) return;
        cart.clicks.push(button.id);
        if (button.id === 'checkout' && location.pathname === '/confirm') {
          cart.confirmed = window.confirm('Place the order?');
        }
        if (cart.interval) {
          cart.clickTick = cart.intervalTicks;
          cart.stop();
        }
        if (button.id === 'checkout' && ['/ordinal', '/dispatch-error'].includes(location.pathname)) {
          history.pushState({}, '', '/receipt');
          const h = document.body.appendChild(document.createElement('h1'));
          h.textContent = 'Checkout complete';
        }
      });
    </script>`);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const flags = ['--isolated', '--headless', '--no-page-id-routing', '--no-usage-statistics', '--no-performance-crux'];
const driver = new ChromeDevToolsDriver(process.env.CAIRN_MCP_ENTRY
  ? { command: process.execPath, args: [process.env.CAIRN_MCP_ENTRY, ...flags] }
  : { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', ...flags] });

// Hook real tool boundaries, never fabricate an AX row, DOM fact or click result.
const call = driver.call.bind(driver);
async function evaluate(body) {
  const reply = await call('evaluate_script', { function: `() => { ${body} }` }, 'observation');
  const json = reply.match(/```json\s*([\s\S]*?)\s*```/);
  assert.ok(json, 'MCP must return JSON for the page-side assertion');
  return JSON.parse(json[1]);
}
const mutate = js => evaluate(`${js}; return true;`);
const clicks = () => evaluate('return cart.clicks;');
const rotate = () => evaluate('return cart.rotate();');
const scope = { target: { role: 'button', name: 'Checkout' }, prerequisites: [
  { role: 'combobox', name: 'Delivery' }, { container: { role: 'list', name: 'Cart rows' }, memberRole: 'checkbox' },
] };
const target = { role: 'button', text: 'Checkout' };
const snapshot = async () => (await driver.snapshotWithGuidanceScope(scope)).facts;

async function checkDriverFacts() {
  await driver.goto(baseUrl);
  const original = await snapshot();
  assert.ok(original?.complete, 'Native checkout, delivery and cart rows must yield a complete observation');
  await mutate("document.querySelector('#promo').textContent = 'Promotion B'");
  assert.deepEqual(await snapshot(), original);
  await mutate("document.querySelector('select').value = 'e'; document.querySelector('#row').checked = true");
  const changed = await snapshot();
  assert.notEqual(changed.prerequisites[0].members[0].value, original.prerequisites[0].members[0].value);
  assert.equal(changed.prerequisites[1].members[0].checked, true);
  await mutate("const el = document.querySelector('#row'); el.replaceWith(el.cloneNode(true))");
  const replaced = await snapshot();
  assert.notEqual(replaced.prerequisites[1].members[0].id, changed.prerequisites[1].members[0].id);
  await mutate("const li = document.querySelector('li'); li.after(li.cloneNode(true))");
  assert.equal((await snapshot()).prerequisites[1].members.length, 2);
  await mutate("document.querySelector('#checkout').disabled = true");
  assert.equal((await snapshot()).targets[0].disabled, true);
  await mutate("const cover = document.body.appendChild(document.createElement('div')); cover.style.cssText = 'position:fixed;inset:0;z-index:50;background:black'");
  assert.equal((await snapshot()).targets[0].occluded, true);
  await mutate("document.querySelector('ul').setAttribute('aria-busy', 'true')");
  assert.equal(await snapshot(), undefined, 'A busy list cannot prove complete membership');
  await driver.goto(baseUrl);
  assert.notEqual((await snapshot()).documentId, original.documentId);
  const cancelled = await driver.snapshotWithGuidanceScope(scope);
  assert.ok(cancelled.targetRef && cancelled.elements.every(e => e.ref !== cancelled.targetRef));
  await assert.rejects(driver.click(target, cancelled.targetRef, () => { throw new Error('budget expired before send'); }),
    /budget expired before send/);
  assert.deepEqual(await clicks(), []);
  // AX exposes the other button, but the DOM inventory cannot inspect its closed tree.
  // Even a distinct name at capture time cannot prove it stays distinct before dispatch.
  await mutate(`const host = document.body.appendChild(document.createElement('div'));
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.appendChild(document.createElement('button')).textContent = 'Other action'`);
  const partial = await driver.snapshotWithGuidanceScope(scope);
  assert.ok(partial.elements.some(el => el.role === 'button' && el.name === 'Other action'));
  assert.equal(partial.facts, undefined, 'Do not attest to complete light DOM coverage for a closed-tree AX peer');
  assert.equal(partial.targetRef, undefined);
}

// Every capture in the promo case sees a real text mutation between take_snapshot and the
// DOM probes. A quiet timer interval or a second lucky capture cannot make this fixture pass.
const scopedSnapshot = driver.snapshotWithGuidanceScope.bind(driver);
const realClick = driver.click.bind(driver);
let active, captureDepth = 0, insideClick = false;
driver.call = async (name, ...args) => {
  if (name === 'click' && active) active.sends++;
  if (name === 'handle_dialog' && active?.variant === 'confirm') active.dialogActions++;
  let result;
  try {
    result = await call(name, ...args);
  } catch (error) {
    if (name === 'click' && active?.variant === 'confirm' && String(error).includes('# Open dialog'))
      active.dialogError = true;
    throw error;
  }
  if (name === 'take_snapshot' && (captureDepth || insideClick) && active?.variant === 'promo') {
    const { tick, text } = await rotate();
    assert.equal(text, `Promotion "Round ${tick}"`);
    active.ticksInCapture++;
  }
  if (name === 'take_snapshot' && insideClick && active?.variant === 'css-after-ax' && !active.cssChanged) {
    await revealTwin();
    active.cssChanged = true;
  }
  return result;
};
driver.snapshotWithGuidanceScope = async declaration => {
  captureDepth++;
  try {
    if (active?.variant === 'promo' && !active.captures) await mutate('cart.start()');
    const result = await scopedSnapshot(declaration);
    if (active) active.captures++;
    return result;
  } finally { captureDepth--; }
};
async function revealTwin() {
  // CSSOM does not notify a MutationObserver. The previously captured button remains
  // connected, visible and unchanged; only a fresh uniqueness check can see the twin.
  const state = await evaluate(`
    const css = document.styleSheets[0];
    const observer = new MutationObserver(() => {});
    observer.observe(document, { subtree:true, attributes:true, childList:true, characterData:true });
    const buttons = () => [...document.querySelectorAll('button')].filter(b => b.checkVisibility()).map(b => b.id);
    const before = buttons();
    css.insertRule('#twin { display: inline-block !important }', css.cssRules.length);
    const after = buttons(), records = observer.takeRecords().length;
    observer.disconnect();
    return { before, after, records };`);
  assert.deepEqual(state, { before: ['checkout'], after: ['checkout', 'twin'], records: 0 });
}
driver.click = async (...args) => {
  if (active) {
    assert.ok(typeof args[1] === 'string' && args[1], 'The engine must send a measured target receipt');
    assert.ok(active.captures >= 2, 'The late mutation must follow both baseline and final measurements');
    active.dispatchGuards++;
    switch (active.variant) {
      case 'promo': await rotate(); break;
      case 'css-duplicate': await revealTwin(); break;
      case 'dom-duplicate': {
        const name = await evaluate(`const b = document.querySelector('#checkout').cloneNode(true);
          b.id = 'late-twin'; document.body.append(b); return b.checkVisibility() && b.textContent;`);
        assert.equal(name, 'Checkout');
        break;
      }
      case 'replacement': await mutate("const b = document.querySelector('#checkout'); b.replaceWith(b.cloneNode(true))"); break;
      case 'ordinal': {
        const order = await evaluate(`const ids = () => [...document.querySelectorAll('button')].map(b => b.id);
          const before = ids(); document.querySelector('#other').remove(); return { before, after: ids() };`);
        assert.deepEqual(order, { before: ['other', 'checkout'], after: ['checkout'] });
        break;
      }
    }
  }
  insideClick = true;
  try { return await realClick(...args); } finally { insideClick = false; }
};

async function runCase(mode, variant) {
  const allow = ['promo', 'ordinal', 'confirm'].includes(variant);
  const gateEvents = [];
  const state = { variant, captures: 0, decisions: 0, sends: 0, dispatchGuards: 0, ticksInCapture: 0,
    dialogActions: 0, dialogError: false };
  active = state;
  try {
    const llm = { id: 'scripted-scoped-guidance', async complete(prompt) {
      if (!prompt.includes('What is the single next action?')) return '[]';
      state.decisions++;
      assert.match(prompt, /Checkout/);
      if (variant === 'promo') state.decisionTick = await evaluate('return cart.intervalTicks;');
      if (variant === 'checked' || variant === 'mixed') {
        const changed = await evaluate(`const c = document.querySelector('#row');
          const before = [c.checked, c.indeterminate]; c.checked = !c.checked;
          return [before, [c.checked, c.indeterminate]];`);
        assert.deepEqual(changed, [[false, variant === 'mixed'], [true, variant === 'mixed']]);
      }
      return JSON.stringify({ action: 'click', ...target });
    } };
    // A rejected decision is deliberately not retried against a new, now legitimate baseline.
    const result = await (mode === 'discover' ? discover : explore)('Check out', {
      driver, llm, baseUrl: `${baseUrl}/${variant}`, maxSteps: 1, pageGuidanceScope: scope,
      pageGuidance: () => ({ text: 'Use Checkout for the selected delivery.', freshness: 'declared-scope' }),
      ...(variant === 'ordinal' && { policy: {
        vet: () => ({ ok: true }),
        stop: (_steps, ctx) => ctx.elements.some(el => el.name === 'Checkout complete'),
      } }),
      trace: startTrace({ emit(event) {
        if (event.kind === 'gate' && event.payload.gate === 'page-guidance') gateEvents.push(event.payload);
      } }, mode).scope(variant),
    });
    assert.equal(state.decisions, 1);
    if (variant === 'confirm' && state.dialogError) {
      // Chrome received the click, but MCP returned an error with an open-dialog notice.
      // Leave that dialog to the host; neither its presence nor its message confirms a click.
      assert.equal(result.truncationReason, 'click-dispatch-uncertain');
      assert.equal(result.truncated, true);
      assert.equal(result.steps.filter(step => step.kind === 'click').length, 0);
      assert.equal(state.sends, 1);
      assert.equal(state.dialogActions, 0);
      await call('handle_dialog', { action: 'dismiss' }); // fixture cleanup, not an engine action
      assert.deepEqual(await clicks(), ['checkout']);
      assert.equal(await evaluate('return cart.confirmed;'), false);
      return result;
    }
    assert.deepEqual(await clicks(), allow ? ['checkout'] : [], `${mode}/${variant}: real DOM click handlers`);
    assert.equal(state.sends, Number(allow), 'Count real MCP click requests, including any retries');
    const frozen = result.steps.filter(step => step.kind === 'click');
    assert.equal(frozen.length, Number(allow), 'Do not freeze a click the browser did not execute');
    if (allow) {
      assert.deepEqual(frozen[0].target, target, 'Do not persist a volatile role index or a scoped receipt');
      assert.equal(gateEvents.length, 0);
      if (variant === 'confirm') {
        assert.equal(state.dialogActions, 1);
        assert.equal(await evaluate('return cart.confirmed;'), true);
      }
    } else {
      const status = variant === 'css-after-ax' ? 'scope-unverifiable'
        : variant.endsWith('duplicate') ? 'target-ambiguous' : 'scope-changed';
      assert.deepEqual(gateEvents.map(e => e.scopeStatus), [status], 'A scope gate must explain the missing click');
    }
    if (['promo', 'ordinal', 'css-duplicate', 'css-after-ax', 'dom-duplicate', 'replacement'].includes(variant))
      assert.equal(state.dispatchGuards, 1, 'Exercise the late guard after a usable final receipt');
    if (variant === 'css-after-ax') assert.equal(state.cssChanged, true, 'The late CSS rule must follow the last AX read');
    if (variant === 'promo') {
      assert.ok(state.ticksInCapture >= 2 && state.ticksInCapture >= state.captures,
        'The promotion must rotate inside every scoped capture, including retries');
      const clickTick = await evaluate('return cart.clickTick ?? null;');
      assert.ok(state.decisionTick >= 1 && clickTick > state.decisionTick,
        `Independent 30ms timer must rotate before decision and until click: ${state.decisionTick} -> ${clickTick}`);
    }
    return result;
  } finally {
    active = undefined;
    if (variant === 'promo') await mutate('cart.stop()');
  }
}

async function replayWithMovedButton(scenario) {
  replayLayout = true;
  let modelCalls = 0;
  try {
    const replay = await runScenario(scenario, { driver, reporter: { async emit() {} },
      llm: { id: 'no-replay-model', async complete() { modelCalls++; throw new Error('Replay called a model'); } } });
    assert.deepEqual(await clicks(), ['checkout'], 'Replay must click Checkout with Keep shopping at the old role index');
    assert.equal(replay.result.verdict.passed, true);
    assert.equal(replay.result.evidence.execution.finalUrl, `${baseUrl}/receipt`);
    assert.equal(modelCalls, 0);
  } finally { replayLayout = false; }
}

// Chrome acts on both requests. Fail the second acknowledgement before the engine sees it.
// The receipt page belongs to Checkout, never to the previously confirmed Start step.
async function checkUnacknowledgedClick(mode) {
  const previousCall = driver.call;
  let sends = 0, decisions = 0;
  driver.call = async (name, ...args) => {
    const result = await previousCall(name, ...args);
    if (name === 'click' && ++sends === 2) throw new Error('Injected click acknowledgement error');
    return result;
  };
  try {
    const result = await (mode === 'discover' ? discover : explore)('Start, then check out', {
      driver, baseUrl: `${baseUrl}/dispatch-error`, maxSteps: 4, pageGuidanceScope: scope,
      pageGuidance: () => ({ text: 'Check the cart.', freshness: 'declared-scope' }),
      llm: { id: 'scripted-click-error', async complete(prompt) {
        assert.ok(prompt.includes('What is the single next action?'), 'Do not propose assertions from the receipt page');
        assert.ok(++decisions <= 2, 'Do not ask for a retry');
        return JSON.stringify({ action: 'click', role: 'button', text: decisions === 1 ? 'Start' : 'Checkout' });
      } },
    });
    assert.equal(result.truncationReason, 'click-dispatch-uncertain');
    assert.equal(result.truncated, true);
    assert.deepEqual(await clicks(), ['start', 'checkout'], 'The browser received each click exactly once');
    assert.equal(await evaluate('return location.pathname;'), '/receipt');
    assert.equal(sends, 2);
    assert.deepEqual(result.steps.map(s => s.kind === 'click' ? s.target.text : s.kind), ['goto', 'Start']);
    assert.equal(result.steps[1].expect, undefined);
    if (mode === 'discover') assert.deepEqual(result.assertions, []);
    else assert.equal(result.finalUrl, `${baseUrl}/dispatch-error`);
  } finally {
    driver.call = previousCall;
  }
}

try {
  await checkDriverFacts();
  for (const mode of ['discover', 'explore']) {
    await checkUnacknowledgedClick(mode);
    console.log(`PASS ${mode}/unacknowledged-click`);
  }
  const failures = [];
  for (const variant of ['promo', 'css-duplicate', 'css-after-ax', 'mixed', 'checked', 'dom-duplicate', 'replacement', 'ordinal', 'confirm']) {
    for (const mode of ['discover', 'explore']) {
      try {
        const result = await runCase(mode, variant);
        if (variant === 'ordinal' && mode === 'discover') await replayWithMovedButton(result);
        console.log(`PASS ${mode}/${variant}`);
      } catch (error) {
        console.error(`FAIL ${mode}/${variant}: ${error.message}`);
        failures.push(error);
      }
    }
  }
  assert.equal(failures.length, 0, `${failures.length} real Chrome scope case(s) failed`);
} finally {
  try { await driver.close(); } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
