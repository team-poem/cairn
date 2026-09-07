import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';

function run(args, status, pattern) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'quickstart.agentic.ts', ...args], {
    encoding: 'utf8', timeout: 120_000,
  });
  const output = result.stdout + result.stderr;
  process.stdout.write(output);
  assert.ifError(result.error);
  assert.equal(result.status, status, args.join(' '));
  assert.match(output, pattern);
}
async function releasedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(4318, '127.0.0.1', resolve));
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
try {
  run(['discover:scripted'], 0, /DISCOVERED: scripted calls=4/);
  run(['freeze'], 0, /FROZEN:/);
  const skill = JSON.parse(await readFile('submit.skill.json', 'utf8'));
  assert.ok(skill.assertions.some((a) => a.kind === 'request-status' && !a.vacuous && a.method === 'POST' && a.status === 200 && a.urlIncludes.includes('/api/submit')));
  run(['replay'], 0, /PASS: replay 2\/2; llmCalls=0; attemptedLlmCalls=0/);
  run(['replay:broken'], 1, /FAIL: request-status POST \/api\/submit expected 200; observed 500; reached \/success/);
  await releasedPort();
  run(['replay', '.artifacts/missing.skill.json'], 2, /ERROR: Cannot load skill.*Run.*discover:scripted/);
  await releasedPort();
  await writeFile('.artifacts/malformed.skill.json', '{ invalid JSON');
  run(['replay', '.artifacts/malformed.skill.json'], 2, /ERROR: Cannot load skill/);
  await releasedPort();
  await writeFile('.artifacts/malformed.skill.json', '{}');
  run(['replay', '.artifacts/malformed.skill.json'], 2, /ERROR: Cannot load skill/);
  await releasedPort();
  console.log('PASS: discovery, freeze/load, two clean replays, broken request, invalid skills, port cleanup');
} finally {
  await rm('.artifacts/malformed.skill.json', { force: true });
}
