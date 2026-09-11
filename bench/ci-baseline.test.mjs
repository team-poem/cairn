import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { baselineHasHarness, renderSizeOnlyComparison } from "./ci-size-only.mjs";
import { postBenchmarkComment } from "../scripts/benchmark-comment.mjs";

const coordinator = fileURLToPath(new URL("./ci-compare.mjs", import.meta.url));
async function checkout(root, name) {
  const path = join(root, name);
  await mkdir(join(path, "packages/harness/dist"), { recursive: true });
  await writeFile(join(path, "packages/harness/package.json"), JSON.stringify({ name: "cairn-size-fixture", version: "1.0.0", files: ["dist"] }));
  await writeFile(join(path, "packages/harness/dist/browser.js"), "export const value = 1;\n");
  const git = (...args) => execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
  git("init", "-q"); git("add", ".");
  git("-c", "user.name=CI Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return { path, git, commit: git("rev-parse", "HEAD") };
}

test("a baseline without the harness still produces actual size comparisons without browser tools", async t => {
  const root = await mkdtemp(join(tmpdir(), "cairn-legacy-baseline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = await checkout(root, "base"), head = await checkout(root, "head");
  const output = join(root, "output");
  const env = { ...process.env, npm_config_cache: join(root, "npm-cache") };
  delete env.CAIRN_MCP_ENTRY;
  delete env.GITHUB_STEP_SUMMARY;
  const run = spawnSync(process.execPath, [coordinator, base.path, head.path, output], { env, encoding: "utf8", timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
  const pair = JSON.parse(await readFile(join(output, "paired.json"), "utf8"));
  assert.equal(pair.kind, "size-only");
  assert.equal(pair.base.commit, base.commit);
  assert.equal(pair.head.commit, head.commit);
  assert.ok(pair.base.sizes.packageBytes > 0);
  assert.equal(pair.base.sizes.browserBytes, pair.head.sizes.browserBytes);
  const markdown = await readFile(join(output, "comparison.md"), "utf8");
  assert.match(markdown, /Replay unavailable/);
  assert.match(markdown, /Package tarball/);
  assert.doesNotMatch(markdown, /All measured attempts passed|0\/0|LLM calls: 0|Median before/);
});

function sizePair() {
  const side = commit => ({ commit: commit.repeat(40), dirty: false, buildHash: "c".repeat(64), sizes: { packageBytes: 100, unpackedBytes: 400, browserBytes: 200, browserGzipBytes: 50 } });
  return { schemaVersion: 1, kind: "size-only", replay: { status: "unavailable", reason: "baseline-harness-absent" }, environment: { node: "v20", esbuild: "0.28.1", platform: "linux", arch: "x64" }, base: side("a"), head: side("b") };
}

test("size-only reports reject malformed data and fabricated replay outcomes", () => {
  for (const mutate of [
    p => { p.schemaVersion = 2; }, p => { p.kind = "complete"; }, p => { p.base.commit = "short"; },
    p => { p.head.sizes.packageBytes = -1; }, p => { p.head.sizes.browserBytes = Infinity; },
    p => { p.head.sizes.packageBytes = "0"; }, p => { delete p.base.sizes.browserBytes; },
    p => { p.replay.reason = "@everyone"; }, p => { p.replay.status = "passed"; },
    p => { p.warmupFailed = false; }, p => { p.base.records = []; }, p => { p.head.llmCalls = 0; },
  ]) {
    const p = sizePair(); mutate(p);
    assert.throws(() => renderSizeOnlyComparison(p), /Invalid size-only/);
  }
  const p = sizePair(); p.base.sizes.packageBytes = 0;
  assert.match(renderSizeOnlyComparison(p), /n\/a/);
});

async function publish(t, pair, conclusion = "success") {
  const cwd = process.cwd(), directory = await mkdtemp(join(tmpdir(), "cairn-size-publish-"));
  process.chdir(directory);
  t.after(async () => { process.chdir(cwd); await rm(directory, { recursive: true, force: true }); });
  await mkdir("benchmark-data"); await writeFile("benchmark-data/paired.json", JSON.stringify(pair));
  const pr = { number: 207, state: "open", base: { sha: "a".repeat(40), repo: { full_name: "team/repo" } }, head: { sha: "b".repeat(40), repo: { full_name: "team/repo" } } };
  const sent = [];
  const github = { rest: {
    repos: { listPullRequestsAssociatedWithCommit: async () => ({ data: [pr] }) },
    pulls: { get: async () => ({ data: pr }) }, users: { getByUsername: async () => ({ data: { id: 123, login: "pingu-cairn[bot]", type: "Bot" } }) },
    issues: { listComments() {}, createComment: async x => sent.push(x), updateComment: async x => sent.push(x) },
  }, paginate: async () => [] };
  await postBenchmarkComment({ github, appSlug: "pingu-cairn", context: { repo: { owner: "team", repo: "repo" }, payload: { workflow_run: {
    event: "pull_request", path: ".github/workflows/benchmark.yml", head_sha: pr.head.sha, head_repository: { full_name: "team/repo" }, conclusion, id: 10, run_attempt: 1,
  } } }, core: { info() {}, warning() {} } });
  return sent;
}

test("publisher shows measured sizes and explicit unavailable replay for a successful legacy baseline run", async t => {
  const comments = await publish(t, sizePair());
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /Replay unavailable/);
  assert.match(comments[0].body, /Package tarball/);
  assert.doesNotMatch(comments[0].body, /did not complete|All measured attempts passed|LLM calls: 0|0\/0/);
});

test("publisher does not turn a failed workflow with size-only data into a successful comparison", async t => {
  const comments = await publish(t, sizePair(), "failure");
  assert.match(comments[0].body, /Measurement did not complete successfully/);
  assert.doesNotMatch(comments[0].body, /Package tarball/);
});

test("publisher still skips stale size-only results", async t => {
  const pair = sizePair(); pair.base.commit = "d".repeat(40);
  assert.deepEqual(await publish(t, pair), []);
});

for (const fault of ["partial tree", "deleted checkout file", "runner failure", "blob instead of tree", "blob ancestor"]) test(`baseline ${fault} remains a failed measurement`, async t => {
  const root = await mkdtemp(join(tmpdir(), "cairn-broken-baseline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = await checkout(root, "base"), head = await checkout(root, "head");
  await mkdir(join(base.path, "bench"), { recursive: true });
  if (fault === "blob ancestor") {
    await rm(join(base.path, "bench"), { recursive: true });
    await writeFile(join(base.path, "bench"), "not a directory");
  } else if (fault === "blob instead of tree") {
    await writeFile(join(base.path, "bench/local"), "not a harness directory");
  } else {
    await mkdir(join(base.path, "bench/local"));
    await writeFile(join(base.path, "bench/local/runner.mjs"), 'export async function runBenchmark() { throw new Error("Synthetic runner failure"); }');
    if (fault !== "partial tree") {
      await writeFile(join(base.path, "bench/local/server.mjs"), "export function fixtureInfo() {} export function startFixture() {}");
      await writeFile(join(base.path, "bench/local/llm.mjs"), "export function createLlm() {}");
      await writeFile(join(base.path, "packages/harness/dist/index.js"), 'export const ENGINE_VERSION = "1.0.0";');
    }
  }
  base.git("add", ".");
  base.git("-c", "user.name=CI Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "harness");
  const commit = base.git("rev-parse", "HEAD");
  if (fault.startsWith("blob")) assert.throws(() => baselineHasHarness(base.path, commit), /not a directory/);
  else assert.equal(baselineHasHarness(base.path, commit), true);
  if (fault === "deleted checkout file") await rm(join(base.path, "bench/local/runner.mjs"));
  const mcp = join(root, "fake-mcp.cjs");
  await writeFile(mcp, 'console.log("1.3.0");');
  const output = join(root, "output");
  const env = { ...process.env, CAIRN_MCP_ENTRY: mcp, CHROME_PATH: process.execPath, npm_config_cache: join(root, "npm-cache") };
  delete env.GITHUB_STEP_SUMMARY;
  const run = spawnSync(process.execPath, [coordinator, base.path, head.path, output], { env, encoding: "utf8", timeout: 30000 });
  assert.equal(run.status, 1, run.stderr);
  const expected = fault === "runner failure" ? /Synthetic runner failure/ : fault.startsWith("blob") ? /not a directory/ : /ERR_MODULE_NOT_FOUND/;
  assert.match(run.stderr, expected);
  const markdown = await readFile(join(output, "comparison.md"), "utf8");
  assert.match(markdown, /Measurement did not complete/);
  assert.doesNotMatch(markdown, /Replay unavailable/);
  await assert.rejects(readFile(join(output, "paired.json")), { code: "ENOENT" });
});
