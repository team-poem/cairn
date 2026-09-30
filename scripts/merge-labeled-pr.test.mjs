import test from "node:test";
import assert from "node:assert/strict";
import { mergeLabeledPullRequests } from "./merge-labeled-pr.mjs";

function fixture() {
  const f = {
    pr: { number: 42, state: "OPEN", isDraft: false, baseRefName: "develop", headRefOid: "head",
      title: "fix(ci): preserve attribution", reviewDecision: "APPROVED", mergeStateStatus: "CLEAN",
      labels: { nodes: [{ name: "Merge" }] } },
    candidates: [{ number: 42, labels: [{ name: "Merge" }] }],
    runs: [{ id: 10, head_sha: "head", event: "pull_request", status: "completed", conclusion: "success" }],
    merged: [], reads: 0,
  };
  const github = {
    graphql: async () => ({ repository: { pullRequest: ++f.reads === 1 ? f.pr : f.current ?? f.pr } }),
    rest: {
      pulls: { list() {}, merge: async args => {
        if (f.error) throw f.error;
        f.merged.push(args);
        return { data: { merged: true, sha: "squash" } };
      } },
      actions: { listWorkflowRuns() {} },
    },
    paginate: async (method, args, map) => {
      if (method === github.rest.pulls.list) return f.candidates;
      assert.equal(args.workflow_id, "ci.yml");
      assert.equal(args.head_sha, "head");
      return map({ data: { workflow_runs: f.runs } });
    },
  };
  f.run = async payload => mergeLabeledPullRequests({ github, ciGithub: f.ciGithub,
    context: { repo: { owner: "team", repo: "cairn" }, payload: payload ?? {} }, core: { info() {} } });
  return f;
}

test("squashes the reviewed head through GitHub without overriding the author's identity", async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.merged, [{ owner: "team", repo: "cairn", pull_number: 42, sha: "head",
    merge_method: "squash", commit_title: "fix(ci): preserve attribution (#42)" }]);
  assert.equal(f.reads, 2);
});

test("reads CI with a separate client when the App has no Actions permission", async () => {
  const f = fixture();
  let read = false;
  f.ciGithub = {
    rest: { actions: { listWorkflowRuns() {} } },
    paginate: async (method, args, map) => {
      assert.equal(method, f.ciGithub.rest.actions.listWorkflowRuns);
      assert.equal(args.head_sha, "head");
      read = true;
      return map({ data: { workflow_runs: f.runs } });
    },
  };
  await f.run();
  assert.equal(read, true);
  assert.equal(f.merged.length, 1);
});

for (const [name, patch] of [
  ["draft", { isDraft: true }], ["closed", { state: "CLOSED" }],
  ["release", { baseRefName: "main" }], ["stacked", { baseRefName: "feat/parent" }],
  ["missing approval despite bot bypass", { reviewDecision: "REVIEW_REQUIRED" }],
  ["changes requested", { reviewDecision: "CHANGES_REQUESTED" }],
  ["missing review rule", { reviewDecision: null }],
  ["conflict", { mergeStateStatus: "DIRTY" }], ["blocked", { mergeStateStatus: "BLOCKED" }],
  ["unknown", { mergeStateStatus: "UNKNOWN" }],
  ["removed label", { labels: { nodes: [] } }],
  ["different label case", { labels: { nodes: [{ name: "merge" }] } }],
]) {
  test(`does not merge a ${name} PR`, async () => {
    const f = fixture();
    Object.assign(f.pr, patch);
    await f.run();
    assert.deepEqual(f.merged, []);
  });
}

for (const [name, runs] of [
  ["absent", []], ["old head", [{ id: 11, head_sha: "old", event: "pull_request", status: "completed", conclusion: "success" }]],
  ["push only", [{ id: 11, head_sha: "head", event: "push", status: "completed", conclusion: "success" }]],
  ...["failure", "cancelled", "skipped", null].map(conclusion => [String(conclusion),
    [{ id: 11, head_sha: "head", event: "pull_request", status: conclusion === null ? "in_progress" : "completed", conclusion }]]),
]) {
  test(`waits for CI when the latest run is ${name}`, async () => {
    const f = fixture();
    f.runs.push(...runs);
    if (!runs.length || ["old head", "push only"].includes(name)) f.runs.shift();
    await f.run();
    assert.deepEqual(f.merged, []);
  });
}

for (const patch of [
  { headRefOid: "new" }, { labels: { nodes: [] } }, { reviewDecision: "CHANGES_REQUESTED" },
  { baseRefName: "main" }, { isDraft: true },
]) {
  test(`rechecks changed PR state before merging: ${JSON.stringify(patch)}`, async () => {
    const f = fixture();
    f.current = { ...f.pr, ...patch };
    await f.run({ pull_request: f.candidates[0] });
    assert.deepEqual(f.merged, []);
  });
}

test("ignores PRs without Merge on both event and periodic paths", async () => {
  const f = fixture();
  f.candidates[0].labels = [];
  await f.run();
  await f.run({ pull_request: f.candidates[0] });
  assert.equal(f.reads, 0);
});

test("a head race is deferred, while permission errors fail visibly", async () => {
  const f = fixture();
  f.error = Object.assign(new Error("Head changed"), { status: 409 });
  await f.run();
  f.error = Object.assign(new Error("Forbidden"), { status: 403 });
  await assert.rejects(f.run(), /Forbidden/);
});
