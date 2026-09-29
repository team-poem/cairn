import assert from 'node:assert/strict';
import {
  ChromeDevToolsDriver, discover,
  type ActionPolicy,
  type LlmClient,
} from 'cairn-engine';
import { startActionPolicyFixture } from './action-policy.fixture.js';

const proof = { kind: 'request-status', method: 'POST', urlIncludes: '/api/view', status: 200 } as const;
const responses = [
  { action: 'click', text: 'Delete all orders', role: 'button', reason: 'Remove every order' },
  { action: 'click', text: 'View orders', role: 'button', reason: 'Open the order list' },
  { action: 'done', assertions: [proof] },
  [proof], // Discovery makes a final assertion-proposal call after `done`.
];
let calls = 0;
const llm: LlmClient = {
  id: 'action-policy-scripted',
  async complete() {
    const response = responses[calls++];
    assert.ok(response, 'Discovery requested an unexpected scripted completion');
    return JSON.stringify(response);
  },
};
const rejected: string[] = [];
const policy: ActionPolicy = {
  vet(decision) {
    if (decision.action === 'click' && decision.text === 'Delete all orders') {
      rejected.push(decision.text);
      return { ok: false, reason: 'Deleting all orders is forbidden in this example' };
    }
    return { ok: true };
  },
};

async function main() {
  const fixture = await startActionPolicyFixture();
  let driver: ChromeDevToolsDriver | undefined;
  try {
    driver = new ChromeDevToolsDriver({
      args: ['-y', 'chrome-devtools-mcp@1.8.0', '--isolated', '--no-page-id-routing', '--headless'],
    });
    const scenario = await discover('View orders, but never delete them.', {
      driver, baseUrl: fixture.baseUrl, llm, policy, maxSteps: 8,
    });
    assert.equal(rejected.length, 1, 'Policy did not reject the destructive proposal');
    assert.equal(rejected[0], 'Delete all orders');
    assert.ok(!scenario.steps.some((step) => 'target' in step && step.target.text === 'Delete all orders'),
      'The rejected click appeared in the discovered scenario');
    assert.deepEqual(fixture.state(), { deleteCount: 0, viewCount: 1 },
      'The forbidden endpoint must remain untouched while the allowed action executes');
    assert.ok(scenario.assertions.some((assertion) =>
      assertion.kind === 'request-status' && !assertion.vacuous && assertion.method === 'POST' &&
      assertion.status === 200 && assertion.urlIncludes.includes('/api/view')),
    'Discovery did not ground the allowed action in fixture traffic');
    assert.equal(calls, 4, 'All scripted responses, including final assertion proposal, must be consumed');
    assert.ok(!scenario.truncated, 'Discovery did not complete');
    console.log('PASS: rejected delete never executed; view executed once; fixture state verified');
  } finally {
    try { await driver?.close(); } finally { await fixture.close(); }
  }
}

main().catch((error: unknown) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
