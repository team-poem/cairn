import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  ChromeDevToolsDriver, FileSkillStore, createLlmClient, discover, runScenario,
  type LlmClient, type Scenario,
} from 'cairn-engine';
import { BASE_URL, startFixture } from './fixture.js';

const intent = 'Enter Cairn in Name and Submit. Prove POST /api/submit returned 200 and reach /success.';
const draftPath = '.artifacts/discovered.json';
const skillPath = process.argv[3] ?? 'submit.skill.json';
const store = new FileSkillStore();

// Implement the public LlmClient port without paying for a model in the reproducible CI demo.
function scriptedClient() {
  const proof = { kind: 'request-status', method: 'POST', urlIncludes: '/api/submit', status: 200 };
  const responses = [
    { action: 'type', text: 'Name', role: 'textbox', value: 'Cairn', reason: 'Fill the submission name' },
    { action: 'click', text: 'Submit', role: 'button', reason: 'Save the name and open success' },
    { action: 'done', assertions: [proof] },
    [proof], // Discovery makes a final assertion-proposal call after `done`.
  ];
  let calls = 0;
  const llm: LlmClient = {
    id: 'quickstart-scripted',
    async complete() {
      const response = responses[calls++];
      assert.ok(response, 'Discovery requested an unexpected scripted completion');
      return JSON.stringify(response);
    },
  };
  return { llm, calls: () => calls };
}

async function withBrowser<T>(broken: boolean, run: (driver: ChromeDevToolsDriver) => Promise<T>): Promise<T> {
  const fixture = await startFixture(broken);
  const driver = new ChromeDevToolsDriver({
    args: ['-y', 'chrome-devtools-mcp@~1.3.0', '--isolated', '--headless'],
  });
  try {
    return await run(driver);
  } finally {
    try { await driver.close(); } finally { await fixture.close(); }
  }
}

async function loadSkill(): Promise<Scenario> {
  try { return await store.load(skillPath); }
  catch (error) {
    throw new Error(`Cannot load skill ${skillPath}. Run "npm run discover:scripted" then "npm run freeze". ${error instanceof Error ? error.message : error}`);
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'discover:scripted' || mode === 'discover') {
    const scripted = scriptedClient();
    const scenario = await withBrowser(false, (driver) => discover(intent, {
      driver, baseUrl: BASE_URL, maxSteps: 8,
      llm: mode === 'discover:scripted' ? scripted.llm : createLlmClient(),
    }));
    if (mode === 'discover:scripted') assert.equal(scripted.calls(), 4, 'All scripted responses must be consumed, including the final proposal');
    assert.ok(!scenario.truncated, 'Discovery did not complete the flow');
    assert.ok(scenario.assertions.some((a) => a.kind === 'request-status' && !a.vacuous && a.method === 'POST' && a.status === 200 && a.urlIncludes.includes('/api/submit')), 'Discovery did not ground the submission proof');
    await mkdir('.artifacts', { recursive: true });
    await writeFile(draftPath, JSON.stringify(scenario, null, 2));
    console.log(`DISCOVERED: ${mode === 'discover:scripted' ? `scripted calls=${scripted.calls()}` : 'real model'}; ${scenario.steps.length} steps; ${draftPath}`);
    return;
  }
  if (mode === 'freeze') {
    // Load validates the discovery output as a bare Scenario before persisting it through the port.
    const scenario = await store.load(draftPath);
    const ref = await store.freeze(skillPath, scenario);
    assert.deepEqual(await store.load(ref), scenario);
    console.log(`FROZEN: ${ref}; FileSkillStore round trip verified`);
    return;
  }
  if (mode !== 'replay' && mode !== 'replay:broken') {
    throw new Error('Usage: quickstart.agentic.ts discover:scripted | discover | freeze | replay | replay:broken [skill path]');
  }
  const broken = mode === 'replay:broken';
  const repetitions = broken ? 1 : 2;
  for (let i = 1; i <= repetitions; i++) {
    await withBrowser(broken, async (driver) => {
      // Load inside the lifetime boundary: invalid inputs also exercise guaranteed cleanup.
      const scenario = await loadSkill();
      let attemptedLlmCalls = 0;
      const llm: LlmClient = {
        id: 'replay-must-not-call-llm',
        async complete() { attemptedLlmCalls++; throw new Error('Replay called the LLM'); },
      };
      const { result } = await runScenario(scenario, { driver, llm, heal: false });
      assert.equal(result.usage?.llmCalls, 0);
      assert.equal(attemptedLlmCalls, 0);
      if (broken) {
        assert.equal(result.verdict.passed, false, 'Broken submission unexpectedly passed');
        assert.ok(result.verdict.results.some(({ assertion: a, passed }) => !passed && a.kind === 'request-status' && !a.vacuous && a.method === 'POST' && a.status === 200 && a.urlIncludes.includes('/api/submit')), 'Missing failed POST proof');
        assert.ok(result.evidence.logic.requests.some((r) => r.method === 'POST' && r.url.includes('/api/submit') && r.status === 500), 'Fixture did not return 500');
        assert.equal(new URL(result.evidence.execution.finalUrl!).pathname, '/success');
        console.log('FAIL: request-status POST /api/submit expected 200; observed 500; reached /success; llmCalls=0');
        process.exitCode = 1;
      } else {
        if (result.verdict.passed) {
          console.log(`PASS: replay ${i}/${repetitions}; llmCalls=0; attemptedLlmCalls=0`);
        } else {
          console.log(`FAIL: replay ${i}/${repetitions}; llmCalls=0; attemptedLlmCalls=0`);
          process.exitCode = 1;
        }
      }
    });
  }
}

main().catch((error: unknown) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 2;
});
