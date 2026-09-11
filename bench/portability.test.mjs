// file: bench/portability.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repository = fileURLToPath(new URL("../", import.meta.url));
const commands = [["bench:discover", "benchmark", "discover"], ["bench:replay", "benchmark", "replay"], ["bench:churn", "churn"]];
const ids = ["saucedemo-checkout", "todomvc-add"];
const scenario = { steps: [{ kind: "goto", url: "https://example.invalid/sentinel" }] };

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cairn bench with spaces ")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => { const path = join(root, name); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, value); };
  put("package.json", JSON.stringify({ type: "module" }));
  put("elsewhere/.keep", "");
  for (const name of ["benchmark", "churn"]) {
    put(`bench/${name}.mjs`, readFileSync(join(repository, "bench", `${name}.mjs`)));
  }
  put("packages/harness/dist/index.js", `
    import { appendFileSync } from 'node:fs';
    const log = (event) => appendFileSync(process.env.BENCH_TEST_LOG, JSON.stringify(event) + '\\n');
    export class ChromeDevToolsDriver { async close() { log({ kind: 'close' }); } }
    export function createLlmClient(options) { log({ kind: 'llm', model: options.model }); return { id: 'stub', complete() { throw Error('Unexpected LLM call'); } }; }
    export async function discover(intent, options) { log({ kind: 'discover', intent, url: options.baseUrl, maxSteps: options.maxSteps }); return { steps: [{ kind: 'goto', url: options.baseUrl }] }; }
    export async function runScenario(scenario, options) { log({ kind: 'replay', scenario, heal: options.heal === true }); return { result: { evidence: { execution: { blocked: false } }, verdict: { passed: true } }, heals: [] }; }
  `);
  // Contain imports in the fixture and avoid opening the churn benchmark's fixed port.
  put("loader.mjs", `export async function resolve(specifier, context, next) {
    const resolved = await next(specifier, context);
    if (!resolved.url.startsWith('node:') && !resolved.url.startsWith(${JSON.stringify(pathToFileURL(root + "/").href)})) throw Error('Benchmark imported outside its checkout: ' + resolved.url);
    return resolved;
  }`);
  put("preload.mjs", `import http from 'node:http'; import { register, syncBuiltinESMExports } from 'node:module';
    http.createServer = () => ({ listen(port, callback) { callback(); }, close() {} });
    syncBuiltinESMExports(); register('./loader.mjs', import.meta.url);`);
  const logPath = join(root, "events.jsonl");
  return {
    root, put,
    events: () => existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [],
    clear: () => rmSync(logPath, { force: true }),
    script: (name, args = []) => spawnSync(process.execPath, ["--import", join(root, "preload.mjs"), join(root, "bench", `${name}.mjs`), ...args], {
      cwd: join(root, "elsewhere"), encoding: "utf8", timeout: 10000,
      env: { ...process.env, BENCH_TEST_LOG: logPath, NODE_OPTIONS: "" },
    }),
    npm: (name, fail = false) => spawnSync("npm", ["run", name, "--", "argument with spaces", "--sentinel"], {
      cwd: root, encoding: "utf8", timeout: 20000,
      env: { ...process.env, BENCH_TEST_LOG: logPath, BENCH_TEST_FAIL: fail ? "1" : "", npm_config_cache: join(root, "npm-cache"), NODE_OPTIONS: "" },
    }),
  };
}

function commandFixture(t) {
  const f = fixture(t);
  f.put("package.json", readFileSync(join(repository, "package.json")));
  const record = "import { appendFileSync } from 'node:fs'; const log = (event) => appendFileSync(process.env.BENCH_TEST_LOG, JSON.stringify(event) + '\\n');";
  f.put("packages/harness/package.json", JSON.stringify({ name: "cairn-engine", type: "module", scripts: { build: "node build.mjs" } }));
  f.put("packages/harness/build.mjs", record + "log({ kind: 'build' }); if (process.env.BENCH_TEST_FAIL) process.exit(23);");
  for (const name of ["benchmark", "churn"]) f.put(`bench/${name}.mjs`, record + `log({ kind: '${name}', args: process.argv.slice(2) });`);
  return f;
}

function succeeds(result) {
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

test("benchmarkDiscoverRelocates: discovery freezes both flows beside its script from another cwd", (t) => {
  const f = fixture(t);
  succeeds(f.script("benchmark", ["discover"]));
  assert.deepEqual(readdirSync(join(f.root, "bench/frozen")).sort(), ids.map((id) => `${id}.json`).sort());
  for (const id of ids) {
    const frozen = JSON.parse(readFileSync(join(f.root, "bench/frozen", `${id}.json`), "utf8"));
    assert.equal(frozen.flow.id, id);
    assert.deepEqual(frozen.scenario.steps, [{ kind: "goto", url: frozen.flow.url }]);
  }
  assert.equal(f.events().filter((e) => e.kind === "discover").length, 2);
  assert.equal(f.events().filter((e) => e.kind === "close").length, 2);
  assert.equal(existsSync(join(f.root, "elsewhere/bench/frozen")), false);
});

test("benchmarkReplayRelocates: replay reads script-local freezes four times each and skips absent files", (t) => {
  const f = fixture(t);
  for (const id of ids) {
    f.put(`bench/frozen/${id}.json`, JSON.stringify({ scenario }));
    f.put(`elsewhere/bench/frozen/${id}.json`, "invalid caller-local decoy");
  }
  const result = f.script("benchmark", ["replay"]);
  succeeds(result);
  assert.deepEqual(f.events(), Array.from({ length: 8 }, () => ({ kind: "replay", scenario, heal: false })));
  assert.equal((result.stdout.match(/4\/4\s+4\/4/g) ?? []).length, 2);
  f.clear();
  rmSync(join(f.root, "bench/frozen"), { recursive: true });
  const missing = f.script("benchmark", ["replay"]);
  succeeds(missing);
  assert.deepEqual(f.events(), []);
  assert.equal((missing.stdout.match(/no frozen scenario/g) ?? []).length, 2);
});

test("churnRelocates: the local public engine preserves discovery and both four-run churn arms", (t) => {
  const f = fixture(t);
  succeeds(f.script("churn"));
  const events = f.events();
  assert.equal(events.filter((e) => e.kind === "discover").length, 1);
  assert.equal(events.filter((e) => e.kind === "close").length, 1);
  assert.deepEqual(events.filter((e) => e.kind === "llm").map((e) => e.model), ["sonnet", "haiku", "haiku", "haiku", "haiku"]);
  const replays = events.filter((e) => e.kind === "replay");
  assert.deepEqual(replays.map((e) => e.heal), [false, false, false, false, true, true, true, true]);
  assert.ok(replays.every((e) => e.scenario.steps[0].url === "http://localhost:8077/v2"));
});

test("benchmarkCommandsBuildFirst: root npm commands build before the selected mode and forward arguments intact", (t) => {
  const f = commandFixture(t);
  for (const [command, script, phase] of commands) {
    f.clear();
    succeeds(f.npm(command));
    assert.deepEqual(f.events(), [{ kind: "build" }, { kind: script, args: [...(phase ? [phase] : []), "argument with spaces", "--sentinel"] }], command);
  }
});

test("benchmarkCommandsStopOnBuildFailure: every npm benchmark stops before execution when the engine build fails", (t) => {
  const f = commandFixture(t);
  for (const [command] of commands) {
    f.clear();
    const result = f.npm(command, true);
    assert.equal(result.error, undefined, String(result.error));
    assert.notEqual(result.status, 0, command);
    assert.deepEqual(f.events(), [{ kind: "build" }], command);
  }
});
