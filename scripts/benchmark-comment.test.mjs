import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postBenchmarkComment } from "./benchmark-comment.mjs";

const marker = "<!-- cairn-pr-benchmarks -->";
function report(commit) {
  return {
    schemaVersion: 1, commit, incomplete: false,
    environment: { node: "v20", chrome: "153", platform: "linux", arch: "x64" },
    workload: { fixtureHash: "fixture", captures: ["navigation", "form", "stateful"].map(tier => ({ tier, scenarioHash: tier })), runs: 4 },
    sizes: { packageBytes: 100, unpackedBytes: 400, browserBytes: 200, browserGzipBytes: 50 },
    records: ["navigation", "form", "stateful"].flatMap(tier => [10, 20, 30, 40].map(elapsedMs => ({ tier, elapsedMs, passed: true, llmCalls: 0, observedLlmCalls: 0 }))),
  };
}

async function fixture(t) {
  const cwd = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "cairn-publisher-test-"));
  process.chdir(directory);
  await mkdir("benchmark-data");
  t.after(async () => { process.chdir(cwd); await rm(directory, { recursive: true, force: true }); });
  const f = {
    pair: { base: report("a".repeat(40)), head: report("b".repeat(40)), warmupFailed: false },
    pr: { number: 227, state: "open", base: { sha: "a".repeat(40), repo: { full_name: "team/repo" } }, head: { sha: "b".repeat(40), repo: { full_name: "team/repo" } } },
    run: { id: 10, run_attempt: 2, event: "pull_request", path: ".github/workflows/benchmark.yml", head_sha: "b".repeat(40), head_repository: { full_name: "team/repo" }, conclusion: "success" },
    bot: { id: 123, login: "pingu-cairn[bot]", type: "Bot" },
    comments: [], sent: [], reads: [], logs: [],
  };
  const github = {
    rest: {
      repos: { listPullRequestsAssociatedWithCommit: async () => ({ data: f.associated ?? [f.pr] }) },
      pulls: { get: async () => { f.reads.push("pr"); return { data: f.reads.filter(x => x === "pr").length === 2 ? f.current ?? f.pr : f.pr }; } },
      users: { getByUsername: async () => { f.reads.push("bot"); return { data: f.bot }; } },
      issues: {
        listComments() {},
        createComment: async data => f.sent.push({ method: "create", ...data }),
        updateComment: async data => f.sent.push({ method: "update", ...data }),
      },
    },
    paginate: async () => f.comments,
  };
  f.publish = async () => {
    if (f.pair !== undefined) await writeFile("benchmark-data/paired.json", JSON.stringify(f.pair));
    await postBenchmarkComment({ github, appSlug: "pingu-cairn", context: { repo: { owner: "team", repo: "repo" }, payload: { workflow_run: f.run } }, core: { info: message => f.logs.push(message), warning: message => f.logs.push(message) } });
  };
  return f;
}

test("fork measurements never receive an app-signed comment even with valid forged identities", async t => {
  const f = await fixture(t);
  f.pr.head.repo.full_name = f.run.head_repository.full_name = "fork/repo";
  f.pair.head.sizes.packageBytes = 1;
  await f.publish();
  assert.deepEqual(f.sent, []);
  assert.ok(!f.reads.includes("bot"));
});

test("compact briefing retains three tables, timing scope and unknown usage without a false zero claim", async t => {
  const f = await fixture(t);
  Object.assign(f.pair.head.records[0], { passed: false, llmCalls: null });
  f.run.conclusion = "failure";
  f.pair.markdown = "@everyone fabricated improvement";
  await f.publish();
  assert.equal(f.sent.length, 1);
  const body = f.sent[0].body;
  assert.match(body, /engine LLM calls: unknown; observed LLM calls: 0/);
  assert.match(body, /23\/24 passed/);
  assert.match(body, /startup.*cleanup/);
  assert.match(body, /navigation: invalid/);
  assert.match(body, /measurement check failed/);
  assert.equal(body.split("\n").filter(line => line.startsWith("| ---")).length, 3);
  assert.doesNotMatch(body, /Provenance|Built JS SHA|@everyone|All measured attempts passed/);
});

test("same-repository briefing preserves mixed size and per-tier effects", async t => {
  const f = await fixture(t);
  f.pair.head.sizes.packageBytes = 90;
  f.pair.head.sizes.browserGzipBytes = 60;
  for (const row of f.pair.head.records) row.elapsedMs *= row.tier === "navigation" ? 0.5 : row.tier === "form" ? 2 : 1;
  await f.publish();
  const body = f.sent[0].body;
  assert.match(body, /Package tarball: -10 B \(-10%\). Browser gzip: \+10 B \(\+20%\)/);
  assert.match(body, /navigation: -50%; form: \+100%; stateful: 0%/);
  assert.match(body, /24\/24 passed; engine LLM calls: 0; observed LLM calls: 0/);
  assert.match(body, /CI noise do not prove an improvement or regression/);
});

for (const [name, change] of [
  ["stale head", f => { f.pr.head.sha = "c".repeat(40); }],
  ["stale base artifact", f => { f.pair.base.commit = "c".repeat(40); }],
  ["stale head artifact", f => { f.pair.head.commit = "c".repeat(40); }],
  ["ambiguous association", f => { f.associated = [f.pr, { ...f.pr, number: 228 }]; }],
  ["closed PR", f => { f.pr.state = "closed"; }],
  ["fork in PR association", f => { f.pr.head.repo.full_name = "fork/repo"; }],
  ["head changed before posting", f => { f.current = structuredClone(f.pr); f.current.head.sha = "c".repeat(40); }],
  ["base changed before posting", f => { f.current = structuredClone(f.pr); f.current.base.sha = "c".repeat(40); }],
  ["newer run already posted", f => { f.comments = [{ id: 8, user: f.bot, body: `${marker}\n<!-- benchmark-run:11:1 -->` }]; }],
  ["newer attempt already posted", f => { f.comments = [{ id: 8, user: f.bot, body: `${marker}\n<!-- benchmark-run:10:3 -->` }]; }],
]) test(`publisher skips ${name}`, async t => {
  const f = await fixture(t);
  change(f);
  await f.publish();
  assert.equal(f.sent.length, 0);
});

for (const [name, change] of [
  ["failed warmup", f => { f.pair.warmupFailed = true; }],
  ["missing warmup status", f => { delete f.pair.warmupFailed; }],
  ["missing data", f => { f.pair = undefined; }],
  ["incomplete output", f => { f.pair.head.incomplete = true; }],
  ["failed workflow despite successful rows", f => { f.run.conclusion = "failure"; }],
  ["unmeasured successful usage", f => { f.pair.head.records[0].llmCalls = null; }],
]) test(`publisher withholds comparisons for ${name}`, async t => {
  const f = await fixture(t);
  change(f);
  await f.publish();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].body, /Measurement did not complete successfully/);
  assert.doesNotMatch(f.sent[0].body, /Observed replay medians|All measured attempts passed/);
});

test("publisher updates only a marked comment owned by the verified numeric bot ID", async t => {
  const f = await fixture(t);
  f.comments = [
    { id: 1, user: { ...f.bot, id: 999 }, body: marker },
    { id: 2, user: { id: 777, login: "human" }, body: marker },
    { id: 3, user: f.bot, body: "unrelated bot comment" },
    { id: 4, user: f.bot, body: `${marker}\n<!-- benchmark-run:10:1 -->` },
  ];
  f.run.path += "@refs/heads/develop";
  await f.publish();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].method, "update");
  assert.equal(f.sent[0].comment_id, 4);
  assert.match(f.sent[0].body, /benchmark-run:10:2/);
});

test("publisher creates its own report when other authors use its marker", async t => {
  const f = await fixture(t);
  f.comments = [{ id: 1, user: { ...f.bot, id: 999 }, body: marker }];
  await f.publish();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].method, "create");
});

test("publisher rejects an unverified App bot", async t => {
  const f = await fixture(t);
  f.bot.type = "User";
  await assert.rejects(f.publish(), /bot identity/);
  assert.equal(f.sent.length, 0);
});

test("publisher rejects a different source workflow", async t => {
  const f = await fixture(t);
  f.run.path = ".github/workflows/ci.yml";
  await assert.rejects(f.publish(), /Unexpected benchmark workflow/);
  assert.equal(f.sent.length, 0);
});
