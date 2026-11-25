import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manager = process.argv[2] ?? 'npm';
const engine = JSON.parse(await readFile(join(root, 'packages/harness/package.json'), 'utf8'));
assert.ok(['npm', 'pnpm', 'yarn'].includes(manager), 'Choose npm, pnpm or yarn');
const yarnVersion = '4.18.1';
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
function packageRun(args, cwd, expected = 0) {
  // Pin modern Yarn without changing the contributor's global Yarn or repository linker.
  return manager === 'yarn'
    ? run('npx', ['--yes', `--package=@yarnpkg/cli-dist@${yarnVersion}`, 'yarn', ...args], cwd, expected)
    : run(manager, args, cwd, expected);
}
try {
  run('npm', ['run', 'build'], root);
  const packed = run('npm', ['pack', '--json', '--pack-destination', temp], join(root, 'packages/harness'), 0, true);
  const packInfo = JSON.parse(packed);
  const tarball = join(temp, Object.values(packInfo)[0].filename);
  const consumer = join(temp, 'quickstart');
  await cp(join(root, 'examples/quickstart'), consumer, {
    recursive: true,
    filter: (path) => !['node_modules', '.artifacts', '.yarn', '.yarnrc.yml', '.pnp.cjs', '.pnp.loader.mjs', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].includes(path.split('/').at(-1)),
  });
  manifest.dependencies['cairn-engine'] = `file:${tarball}`;
  if (manager === 'yarn') {
    manifest.packageManager = `yarn@${yarnVersion}`;
    // This fresh consumer has no lockfile; keep PnP strict and dependency builds disabled.
    await writeFile(join(consumer, '.yarnrc.yml'), 'nodeLinker: pnp\npnpMode: strict\npnpFallbackMode: none\nenableScripts: false\nenableImmutableInstalls: false\nenableGlobalCache: false\n');
  }
  await writeFile(join(consumer, 'package.json'), JSON.stringify(manifest, null, 2));
  packageRun(manager === 'yarn' ? ['install'] : ['install', '--ignore-scripts'], consumer);
  if (manager === 'yarn') {
    assert.equal(packageRun(['--version'], consumer).trim(), yarnVersion);
    assert.ok(existsSync(join(consumer, '.pnp.cjs')), 'Yarn must generate a PnP loader');
    packageRun(['node', '-e', 'require("node:assert/strict").ok(process.versions.pnp, "PnP must be active")'], consumer);
  }
  packageRun(['run', 'typecheck'], consumer);
  const exec = manager === 'npm' ? ['exec', '--', 'cairn'] : ['exec', 'cairn'];
  assert.equal(packageRun([...exec, '--version'], consumer).trim(), engine.version);
  packageRun([...exec, 'not-a-command'], consumer, 2);
  packageRun([...exec, 'replay'], consumer, 2); // usage, not a verdict (#173)
  const { build } = await import('esbuild');
  await writeFile(join(consumer, 'browser.ts'), 'export * from "cairn-engine/browser";\n');
  await build({ absWorkingDir: consumer, entryPoints: ['browser.ts'], outfile: join(temp, 'browser.js'), bundle: true, platform: 'browser', format: 'esm' });
  packageRun(['run', 'verify'], consumer);
  if (manager === 'yarn') assert.ok(!existsSync(join(consumer, 'node_modules')), 'PnP consumer must not fall back to node_modules');
  console.log(`PASS: ${manager}${manager === 'yarn' ? ' PnP' : ''} tarball consumer, public types, installed CLI, browser bundle, and Chrome quickstart`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
