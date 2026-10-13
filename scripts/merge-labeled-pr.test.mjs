import test from "node:test";
import assert from "node:assert/strict";
import { mergeLabeledPullRequests } from "./merge-labeled-pr.mjs";

function fixture() {
  const f = {
    pr: { number: 42, state: "OPEN", isDraft: false, baseRefName: "develop", headRefOid: "head",
      title: "fix(ci): preserve attribution", reviewDecision: "APPROVED", mergeStateStatus: "CLEAN",
      labels: { nodes: [{ name: "needs-merge" }] } },
    candidates: [{ number: 42, labels: [{ name: "needs-merge" }] }],
    runs: [{ id: 10, head_sha: "head", event: "pull_request", status: "completed", conclusion: "success" }],
    merged: [], reads: 0, ciReads: 0, messages: [],
    summary: { headings: [], items: [], writes: 0 },
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
      f.ciReads++;
      assert.equal(args.workflow_id, "ci.yml");
      assert.equal(args.head_sha, "head");
      // Octokit normalizes each page's workflow_runs envelope to response.data first.
      return (f.pages ?? [f.runs]).flatMap(data => map ? map({ data }) : data);
    },
  };
  const summary = {
    addHeading(heading) { f.summary.headings.push(heading); return this; },
    addList(items) { f.summary.items.push(...items); return this; },
    async write() { f.summary.writes++; },
  };
  f.run = async payload => mergeLabeledPullRequests({ github, ciGithub: f.ciGithub,
    context: { repo: { owner: "team", repo: "cairn" }, payload: payload ?? {} },
    core: { info(message) { f.messages.push(message); }, summary } });
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
      return [].concat(map ? map({ data: f.runs }) : f.runs);
    },
  };
  await f.run();
  assert.equal(read, true);
  assert.equal(f.merged.length, 1);
});

for (const conclusion of ["success", "failure"]) {
  test(`uses the latest matching CI run across normalized pages (${conclusion})`, async () => {
    const f = fixture();
    f.pages = [
      f.runs,
      [{ ...f.runs[0], id: 13, head_sha: "old" }, { ...f.runs[0], id: 12, event: "push" }],
      [{ ...f.runs[0], id: 11, conclusion }],
    ];
    await f.run();
    assert.equal(f.merged.length, conclusion === "success" ? 1 : 0);
    if (conclusion === "failure") assert.match(f.messages.join("\n"), /CI run 11.*failure/);
  });
}

for (const [name, patch] of [
  ["draft", { isDraft: true }], ["closed", { state: "CLOSED" }],
  ["release", { baseRefName: "main" }], ["stacked", { baseRefName: "feat/parent" }],
  ["missing approval despite bot bypass", { reviewDecision: "REVIEW_REQUIRED" }],
  ["changes requested", { reviewDecision: "CHANGES_REQUESTED" }],
  ["missing review rule", { reviewDecision: null }],
  ["conflict", { mergeStateStatus: "DIRTY" }], ["blocked", { mergeStateStatus: "BLOCKED" }],
  ["unknown", { mergeStateStatus: "UNKNOWN" }],
  ["removed label", { labels: { nodes: [] } }],
  ["different label case", { labels: { nodes: [{ name: "Needs-Merge" }] } }],
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

test("ignores periodic candidates without either merge label", async () => {
  const f = fixture();
  f.candidates[0].labels = [];
  await f.run();
  assert.equal(f.reads, 0);
});

test("reads current labels when the event snapshot lacks needs-merge", async () => {
  const f = fixture();
  await f.run({ pull_request: { ...f.candidates[0], labels: [] } });
  assert.equal(f.reads, 2);
  assert.equal(f.merged.length, 1);
});

test("does not merge an event PR whose current labels have no merge request", async () => {
  const f = fixture();
  f.pr.labels.nodes = [];
  await f.run({ pull_request: { ...f.candidates[0], labels: [] } });
  assert.equal(f.reads, 1);
  assert.equal(f.ciReads, 0);
  assert.deepEqual(f.merged, []);
  assert.match(f.messages.join("\n"), /needs-merge/);
});

for (const labels of [["needs-merge", "no-merge"], ["no-merge"]]) {
  for (const path of ["event", "periodic"]) {
    test(`no-merge blocks ${labels.join(" and ")} on the ${path} path and reports the reason`, async () => {
      const f = fixture();
      f.pr.labels.nodes = labels.map(name => ({ name }));
      f.candidates[0].labels = labels.map(name => ({ name }));
      await f.run(path === "event" ? { pull_request: f.candidates[0] } : undefined);
      assert.equal(f.reads, 1);
      assert.equal(f.ciReads, 0);
      assert.deepEqual(f.merged, []);
      assert.match(f.messages.join("\n"), /no-merge/);
      assert.match(f.summary.items.join("\n"), /no-merge/);
      assert.equal(f.summary.writes, 1);
    });
  }
}

test("no-merge added during CI lookup cancels an otherwise eligible merge", async () => {
  const f = fixture();
  f.current = { ...f.pr, labels: { nodes: [{ name: "needs-merge" }, { name: "no-merge" }] } };
  await f.run({ pull_request: f.candidates[0] });
  assert.equal(f.reads, 2);
  assert.equal(f.ciReads, 1);
  assert.deepEqual(f.merged, []);
  assert.match(f.summary.items.join("\n"), /no-merge/);
});

for (const stage of ["initial", "final"]) {
  test(`an incomplete label list at the ${stage} read cannot hide no-merge`, async () => {
    const f = fixture();
    const labels = { nodes: [{ name: "needs-merge" }], pageInfo: { hasNextPage: true } };
    if (stage === "initial") f.pr.labels = labels;
    else f.current = { ...f.pr, labels };
    await f.run();
    assert.deepEqual(f.merged, []);
    assert.equal(f.ciReads, stage === "initial" ? 0 : 1);
    assert.match(f.summary.items.join("\n"), /incomplete.*no-merge/);
  });
}

test("removing no-merge allows a retained needs-merge request despite the stale event", async () => {
  const f = fixture();
  await f.run({ pull_request: { ...f.candidates[0], labels: [{ name: "needs-merge" }, { name: "no-merge" }] } });
  assert.equal(f.reads, 2);
  assert.equal(f.ciReads, 1);
  assert.equal(f.merged.length, 1);
});

test("reports failed CI when GitHub also reports an unstable merge state", async () => {
  const f = fixture();
  f.pr.mergeStateStatus = "UNSTABLE";
  f.runs[0].conclusion = "failure";
  await f.run();
  assert.equal(f.ciReads, 1);
  assert.deepEqual(f.merged, []);
  assert.ok(f.messages.some(message => /CI/i.test(message) && /failure/i.test(message)));
  assert.ok(f.summary.items.some(message => /CI/i.test(message) && /failure/i.test(message)));
});

test("a head race is deferred, while permission errors fail visibly", async () => {
  const f = fixture();
  f.error = Object.assign(new Error("Head changed"), { status: 409 });
  await f.run();
  f.error = Object.assign(new Error("Forbidden"), { status: 403 });
  await assert.rejects(f.run(), /Forbidden/);
});
