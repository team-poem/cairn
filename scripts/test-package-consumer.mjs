import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manager = process.argv[2] ?? 'npm';
const engine = JSON.parse(await readFile(join(root, 'packages/harness/package.json'), 'utf8'));
assert.ok(['npm', 'pnpm'].includes(manager), 'Choose npm or pnpm');
const manifest = JSON.parse(await readFile(join(root, 'examples/quickstart/package.json'), 'utf8'));
assert.equal(manifest.dependencies['cairn-engine'], '^2.8.0');
const temp = await mkdtemp(join(tmpdir(), 'cairn-consumer-'));
function run(command, args, cwd, expected = 0, quiet = false) {
  const env = { ...process.env };
  if (command === 'npm' && args.includes('install') && args.includes('--ignore-scripts')) {
    // npm 12 forwards this user setting through `npm run`, then rejects it as a
    // project-install CLI option. Let npm reread its config; lifecycle scripts stay disabled.
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
    }
  }
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 240_000 });
  if (!quiet) process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  assert.ifError(result.error);
  assert.equal(result.status, expected, `${command} ${args.join(' ')} exit`);
  return result.stdout;
}
try {
  run('npm', ['run', 'build'], root);
  const packed = run('npm', ['pack', '--json', '--pack-destination', temp], join(root, 'packages/harness'), 0, true);
  const packInfo = JSON.parse(packed);
  const tarball = join(temp, Object.values(packInfo)[0].filename);
  const consumer = join(temp, 'quickstart');
  await cp(join(root, 'examples/quickstart'), consumer, {
    recursive: true,
    filter: (path) => !['node_modules', '.artifacts', 'package-lock.json', 'pnpm-lock.yaml'].includes(path.split('/').at(-1)),
  });
  manifest.dependencies['cairn-engine'] = `file:${tarball}`;
  await writeFile(join(consumer, 'package.json'), JSON.stringify(manifest, null, 2));
  run(manager, ['install', '--ignore-scripts'], consumer);
  run(manager, ['run', 'typecheck'], consumer);
  const bin = join(consumer, 'node_modules/.bin/cairn');
  assert.equal(run(bin, ['--version'], consumer).trim(), engine.version);
  run(bin, ['not-a-command'], consumer, 2);
  run(bin, ['replay'], consumer, 1);
  const { build } = await import('esbuild');
  await writeFile(join(consumer, 'browser.ts'), 'export * from "cairn-engine/browser";\n');
  await build({ entryPoints: [join(consumer, 'browser.ts')], outfile: join(temp, 'browser.js'), bundle: true, platform: 'browser', format: 'esm' });
  run(manager, ['run', 'verify'], consumer);
  console.log(`PASS: ${manager} tarball consumer, public types, installed CLI, browser bundle, and Chrome quickstart`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
