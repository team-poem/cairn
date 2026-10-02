import assert from 'node:assert/strict';
import { readFile, access, cp, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(join(root, path), 'utf8');

test('GitHub and npm READMEs share content with platform-safe links', async () => {
  const github = await read('README.md');
  const npm = await read('packages/harness/README.md');
  const expected = github.replace('# cairn\n', '# cairn-engine\n')
    .replace('src="banner.svg"', 'src="https://raw.githubusercontent.com/team-poem/cairn/main/banner.svg"')
    .replace(/\]\((?!https?:|#)([^)]+)\)/g, (_, path) => {
      const base = path.endsWith('.svg') ? 'https://raw.githubusercontent.com/team-poem/cairn/main/'
        : `https://github.com/team-poem/cairn/${path.startsWith('examples/') ? 'tree' : 'blob'}/main/`;
      return `](${base}${path})`;
    });
  assert.equal(npm, expected);
  for (const match of github.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)) {
    await access(join(root, match[1].split('#')[0]));
  }
  const sections = ['## Where it fits', '## See it work', '## Try it locally', '## Benchmarks'];
  const positions = sections.map(section => github.indexOf(section));
  assert(positions.every((position, i) => position >= 0 && (!i || position > positions[i - 1])));
  assert.equal((github.match(/!\[[^\]]*\]\([^)]*228-[^)]*\.svg\)/g) ?? []).length, 1);
  assert(github.includes('228-shared-calls.svg'));
});

test('the shared chart reproduces from unchanged benchmark sources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cairn-readme-chart-'));
  try {
    for (const name of ['228-render-calls.mjs', '228-codex.json', '228-claude-calls.json']) {
      await cp(join(root, 'docs/benchmarks', name), join(dir, name));
    }
    execFileSync(process.execPath, [join(dir, '228-render-calls.mjs')]);
    for (const name of ['228-shared-calls.svg', '228-calls.svg', '228-claude-calls.svg']) {
      assert.equal(await readFile(join(dir, name), 'utf8'), await read(`docs/benchmarks/${name}`));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
