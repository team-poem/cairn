import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { compareReports, renderComparison } from "./ci-report.mjs";
import { postBenchmarkComment } from "../scripts/benchmark-comment.mjs";

const repository = "team/repo";
function report(commit, times) {
  return {
    schemaVersion: 1, commit, incomplete: false,
    environment: { node: "v20", chrome: "153", platform: "linux", arch: "x64" },
    workload: { fixtureHash: "fixture", captures: ["navigation", "form", "stateful"].map(tier => ({ tier, scenarioHash: tier })), runs: 4 },
    sizes: { packageBytes: 100, unpackedBytes: 400, browserBytes: 200, browserGzipBytes: 50 },
    records: ["navigation", "form", "stateful"].flatMap(tier => times.map(elapsedMs => ({ tier, elapsedMs, passed: true, llmCalls: 0, observedLlmCalls: 0 }))),
  };
}

async function fixture(t) {
  const cwd = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "cairn-comment-guards-"));
  process.chdir(directory);
  await mkdir("benchmark-data");
  t.after(async () => { process.chdir(cwd); await rm(directory, { recursive: true, force: true }); });
  const pair = { base: report("a".repeat(40), [10, 40, 50, 80]), head: report("b".repeat(40), [20, 30, 60, 70]), warmupFailed: false };
  await writeFile("benchmark-data/paired.json", JSON.stringify(pair));
  const pr = { number: 227, state: "open", base: { sha: pair.base.commit, repo: { full_name: repository } }, head: { sha: pair.head.commit, repo: { full_name: repository } } };
  const f = {
    pair, associated: [structuredClone(pr)], pr, current: structuredClone(pr), calls: [], sent: [],
    run: { id: 10, run_attempt: 1, event: "pull_request", path: ".github/workflows/benchmark.yml", head_sha: pair.head.commit, head_repository: { full_name: repository }, conclusion: "success" },
  };
  let reads = 0;
  const github = { rest: {
    repos: { listPullRequestsAssociatedWithCommit: async () => { f.calls.push("associate"); return { data: f.associated }; } },
    pulls: { get: async () => { f.calls.push("pr"); return { data: ++reads === 1 ? f.pr : f.current }; } },
    users: { getByUsername: async () => { f.calls.push("bot"); return { data: { id: 123, login: "pingu-cairn[bot]", type: "Bot" } }; } },
    issues: { listComments() {}, createComment: async value => f.sent.push(value), updateComment: async value => f.sent.push(value) },
  }, paginate: async () => [] };
  f.publish = () => postBenchmarkComment({ github, appSlug: "pingu-cairn", context: { repo: { owner: "team", repo: "repo" }, payload: { workflow_run: f.run } }, core: { info() {}, warning() {} } });
  return f;
}

test("PR comment omits p95 while keeping three tables, medians and artifact tail data", async t => {
  const f = await fixture(t);
  await f.publish();
  assert.equal(f.sent.length, 1);
  const body = f.sent[0].body;
  assert.doesNotMatch(body, /p95/i);
  assert.equal(body.split("\n").filter(line => line.startsWith("| ---")).length, 3);
  assert.match(body, /\| navigation \| 4 \/ 4 \| 45 \| 45 \| 0 \| 0% \| unchanged \|/);
  assert.match(body, /startup.*cleanup/);
  assert.match(body, /order bias/);
  const artifact = renderComparison(compareReports(f.pair.base, f.pair.head));
  assert.match(artifact, /p95 before \/ after ms/);
  assert.match(artifact, /\| 80 \/ 70 \|/);
});

test("comment job rejects fork runs before any token step can run", async () => {
  const workflow = await readFile(new URL("../.github/workflows/benchmark-comment.yml", import.meta.url), "utf8");
  const job = workflow.split(/^  comment:\s*$/m)[1]?.split(/^  [\w-]+:\s*$/m)[0];
  const condition = job?.match(/^    if: \$\{\{ (.+) \}\}\s*$/m)?.[1];
  assert.ok(condition, "The comment job needs a job-level eligibility condition");
  // This workflow uses the shared JS/Actions subset: property access, ==, &&.
  // Evaluate the actual job condition without invoking the publisher's guards.
  const eligible = (event, headRepository) => runInNewContext(condition, { github: {
    repository, event: { workflow_run: { event, head_repository: { full_name: headRepository } } },
  } }, { timeout: 100 });
  assert.equal(eligible("pull_request", repository), true);
  assert.equal(eligible("pull_request", "fork/repo"), false);
  assert.equal(eligible("push", repository), false);
  assert.equal(eligible("pull_request", undefined), false);
});

for (const source of ["fork/repo", undefined]) test(`publisher rejects run repository ${source} before PR association`, async t => {
  const f = await fixture(t);
  f.run.head_repository = source === undefined ? undefined : { full_name: source };
  // Association and PR objects remain independently eligible, so they cannot
  // hide deletion of the early run-repository guard.
  await f.publish();
  assert.deepEqual(f.calls, []);
  assert.equal(f.sent.length, 0);
});

test("publisher rejects a fork in the first authoritative PR read before bot lookup", async t => {
  const f = await fixture(t);
  f.pr.head.repo.full_name = "fork/repo";
  // The commit association and final read are separate same-repo snapshots.
  await f.publish();
  assert.deepEqual(f.calls, ["associate", "pr"]);
  assert.equal(f.sent.length, 0);
});

test("publisher rejects a fork in the final authoritative PR read before writing", async t => {
  const f = await fixture(t);
  f.current.head.repo.full_name = "fork/repo";
  await f.publish();
  assert.deepEqual(f.calls, ["associate", "pr", "bot", "pr"]);
  assert.equal(f.sent.length, 0);
});
