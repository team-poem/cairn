// Run from the repository root: npm run build && node examples/contract-identity.mjs
import assert from 'node:assert/strict';
import { identifyScenario, compareContracts, runScenario, FakeDriver } from '../packages/harness/dist/index.js';

const scenario = await identifyScenario({
  name: 'Cart is reachable',
  steps: [{ kind: 'goto', url: 'https://shop.example/cart' }],
  assertions: [{ kind: 'navigated', to: 'shop.example/cart' }],
}, { intent: 'Open the cart' });

const replay = async (scenario, finalUrl) => {
  const { result } = await runScenario(scenario, {
    driver: new FakeDriver({ evidence: {
      execution: { actions: [], navigated: true, finalUrl, blocked: false },
      perception: {}, logic: { requests: [], console: [] },
    } }),
    reporter: { emit: async () => {} },
    llm: { id: 'forbidden', complete: async () => { throw new Error('Replay must not call a model'); } },
  });
  assert.equal(result.usage.llmCalls, 0);
  return result.verdict;
};

const green = await replay(scenario, 'https://shop.example/cart');
const red = await replay(scenario, 'https://shop.example/error');
assert.equal(green.passed, true);
assert.equal(red.passed, false);
assert.equal(compareContracts(green.contract, red.contract), 'same');
console.log('Same declared contract, different outcome: inspect failure class and evidence.');

const strengthened = { ...scenario, assertions: [...scenario.assertions,
  { kind: 'request-status', urlIncludes: '/api/cart', status: 200 },
] };
const changed = await replay(strengthened, 'https://shop.example/cart');
assert.equal(changed.passed, false);
assert.equal(compareContracts(green.contract, changed.contract), 'changed');
console.log('Checks changed: do not present this as an unchanged-contract regression.');
assert.deepEqual(scenario.contract, green.contract);

const { contract: _old, ...legacy } = scenario;
const unknown = await replay(legacy, 'https://shop.example/cart');
assert.equal(compareContracts(green.contract, unknown.contract), 'unknown');
console.log('Legacy original intent is unknown: do not assume contract equivalence.');
