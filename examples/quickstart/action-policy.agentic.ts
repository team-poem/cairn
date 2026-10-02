import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  ChromeDevToolsDriver, discover,
  type ActionPolicy, type LlmClient, type Target,
} from 'cairn-engine';

// Count dispatches as well as server effects: an ineffective click must not look like a rejection.
class ObservedDriver extends ChromeDevToolsDriver {
  clicks: string[] = [];
  override async click(target: Target, ref?: string): Promise<void> {
    this.clicks.push(target.text ?? '');
    return super.click(target, ref);
  }
}

async function main() {
  let deleted = 0;
  let saved = 0;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'POST' && ['/delete', '/save'].includes(request.url ?? '')) {
      if (request.url === '/delete') deleted++;
      else saved++;
      response.writeHead(200).end('OK');
      return;
    }
    if (request.url !== '/') { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html lang="en"><title>Policy example</title>
      <button onclick="act('/delete')">Delete record</button>
      <button onclick="act('/save')">Save record</button><p role="status">Ready</p>
      <script>async function act(path) {
        await fetch(path, {method: 'POST'});
        document.querySelector('[role=status]').textContent = path === '/save' ? 'Saved' : 'Deleted';
      }</script></html>`);
  });
  const driver = new ObservedDriver({
    args: ['-y', 'chrome-devtools-mcp@1.8.0', '--isolated', '--no-page-id-routing', '--headless'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    let rejected = 0;
    const policy: ActionPolicy = {
      vet(decision) {
        // Deliberately narrow: these are the two named controls in this fixture.
        if (decision.action === 'click' && decision.text === 'Save record') return { ok: true };
        rejected++;
        return { ok: false, reason: 'Only Save record is allowed in this example' };
      },
    };
    const proof = { kind: 'request-status', method: 'POST', urlIncludes: '/save', status: 200 };
    const replies = [
      { action: 'click', text: 'Delete record', role: 'button', reason: 'Attempt the forbidden action' },
      { action: 'click', text: 'Save record', role: 'button', reason: 'Take the allowed path' },
      { action: 'done', assertions: [proof] },
      [proof],
    ];
    let calls = 0;
    const llm: LlmClient = {
      id: 'policy-scripted',
      async complete() {
        const reply = replies[calls++];
        assert.ok(reply, 'Unexpected model call');
        return JSON.stringify(reply);
      },
    };
    const scenario = await discover('Save the record. Never delete it.', {
      driver, llm, policy, baseUrl: `http://127.0.0.1:${address.port}`, maxSteps: 6,
    });
    assert.equal(calls, replies.length, 'The forbidden proposal and allowed continuation must both run');
    assert.equal(rejected, 1, 'The policy must reject the forbidden proposal');
    assert.deepEqual(driver.clicks, ['Save record'], 'Forbidden actions must never reach driver.click');
    assert.equal(deleted, 0, 'The record must not be deleted');
    assert.equal(saved, 1, 'The allowed action must change fixture state');
    assert.ok(!scenario.truncated, 'Discovery must finish');
    assert.ok(scenario.assertions.some(a => a.kind === 'request-status' && a.method === 'POST'
      && a.urlIncludes.includes('/save') && a.status === 200 && !a.vacuous),
      `Save proof must be observed: ${JSON.stringify(scenario.assertions)}`);
    console.log('PASS: forbidden proposals=1; rejected=1; clicks=Save record; deleted=0; saved=1');
  } finally {
    try { await driver.close(); }
    finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
