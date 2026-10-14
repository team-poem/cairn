import test from "node:test";
import assert from "node:assert/strict";
import { mergeLabeledPullRequests } from "./merge-labeled-pr.mjs";

const commentMarker = "<!-- cairn-pingu-merge-decision -->";

function fixture() {
  const f = {
    pr: { number: 42, state: "OPEN", isDraft: false, baseRefName: "develop", headRefOid: "head",
      title: "fix(ci): preserve attribution", reviewDecision: "APPROVED", mergeStateStatus: "CLEAN",
      labels: { nodes: [{ name: "needs-merge" }] } },
    candidates: [{ number: 42, labels: [{ name: "needs-merge" }] }],
    runs: [{ id: 10, head_sha: "head", event: "pull_request", status: "completed", conclusion: "success" }],
    merged: [], removedLabels: [], addedLabels: [], operations: [], reads: 0, ciReads: 0, messages: [],
    comments: [], commentWrites: [], warnings: [], restReads: 0,
    bot: { id: 77, type: "Bot", login: "cairn-pingu[bot]" },
    summary: { headings: [], items: [], writes: 0 },
  };
  const github = {
    graphql: async () => {
      f.reads++;
      const pr = f.snapshots?.[Math.min(f.reads - 1, f.snapshots.length - 1)]
        ?? (f.reads === 1 ? f.pr : f.current ?? f.pr);
      const result = structuredClone(f.didMerge ? { ...pr, state: "MERGED" } : pr);
      result.labels.pageInfo ??= { hasNextPage: false };
      f.lastPr = result;
      return { repository: { pullRequest: structuredClone(result) } };
    },
    rest: {
      pulls: { list() {}, get: async args => {
        f.restReads++;
        assert.deepEqual(args, { owner: "team", repo: "cairn", pull_number: 42 });
        const pr = f.lastPr ?? f.current ?? f.pr;
        return { data: f.restCurrent ?? {
          state: !f.didMerge && pr.state === "OPEN" ? "open" : "closed",
          merged: f.didMerge || pr.state === "MERGED",
          base: { ref: pr.baseRefName }, head: { sha: pr.headRefOid }, labels: pr.labels.nodes,
        } };
      }, merge: async args => {
        f.operations.push("merge");
        if (f.error) throw f.error;
        f.merged.push(args);
        const data = f.mergeResult ?? { merged: true, sha: "squash" };
        if (data.merged) f.didMerge = true;
        return { data };
      } },
      users: { getByUsername: async args => {
        assert.deepEqual(args, { username: "cairn-pingu[bot]" });
        return { data: f.bot };
      } },
      issues: { listComments() {}, createComment: async args => {
        if (f.commentError) throw f.commentError;
        f.commentWrites.push({ method: "create", ...args });
        f.comments.push({ id: 100, user: f.bot, body: args.body });
        return { data: { id: 100 } };
      }, updateComment: async args => {
        if (f.commentError) throw f.commentError;
        f.commentWrites.push({ method: "update", ...args });
        f.comments.find(comment => comment.id === args.comment_id).body = args.body;
        return { data: {} };
      }, removeLabel: async args => {
        f.operations.push("removeLabel");
        f.removedLabels.push(args);
        if (f.cleanupError) throw f.cleanupError;
        return { data: [] };
      }, addLabels: async args => { f.addedLabels.push(args); return { data: [] }; } },
      actions: { listWorkflowRuns() {} },
    },
    paginate: async (method, args, map) => {
      if (method === github.rest.pulls.list) return f.candidates;
      if (method === github.rest.issues.listComments) {
        assert.deepEqual(args, { owner: "team", repo: "cairn", issue_number: 42, per_page: 100 });
        return f.comments;
      }
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
    core: { info(message) { f.messages.push(message); }, warning(message) { f.warnings.push(message); }, summary } });
  return f;
}

test("squashes the reviewed head through GitHub without overriding the author's identity", async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.merged, [{ owner: "team", repo: "cairn", pull_number: 42, sha: "head",
    merge_method: "squash", commit_title: "fix(ci): preserve attribution (#42)" }]);
  assert.deepEqual(f.removedLabels, [{ owner: "team", repo: "cairn", issue_number: 42, name: "needs-merge" }]);
  assert.deepEqual(f.addedLabels, []);
  assert.deepEqual(f.operations, ["merge", "removeLabel"]);
  assert.equal(f.reads, 3);
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
    assert.deepEqual(f.removedLabels, []);
  });
}

for (const [name, change, reason] of [
  ["review label", f => { f.pr.labels.nodes.push({ name: "status/1-needs-review" }); }, /status\/1-needs-review/],
  ["no-merge", f => { f.pr.labels.nodes.push({ name: "no-merge" }); }, /no-merge/],
  ["missing approval", f => { f.pr.reviewDecision = "REVIEW_REQUIRED"; }, /waiting for approval/],
  ["failed CI", f => { f.runs[0].conclusion = "failure"; }, /CI failure/],
  ["pending CI", f => { f.runs[0].status = "in_progress"; f.runs[0].conclusion = null; }, /waiting for CI/],
  ["conflicts", f => { f.pr.mergeStateStatus = "DIRTY"; }, /resolve the merge conflicts/],
  ["missing needs-merge", f => { f.pr.labels.nodes = []; }, /no needs-merge request/],
]) {
  test(`posts the current merge decision for ${name} without changing eligibility`, async () => {
    const f = fixture();
    change(f);
    await f.run({ pull_request: f.candidates[0] });
    assert.deepEqual(f.merged, []);
    assert.deepEqual(f.removedLabels, []);
    assert.equal(f.commentWrites.length, 1);
    assert.equal(f.commentWrites[0].method, "create");
    assert.equal(f.commentWrites[0].issue_number, 42);
    assert.ok(f.commentWrites[0].body.startsWith(`${commentMarker}\nMerge pending:`));
    assert.match(f.commentWrites[0].body, reason);
    assert.deepEqual(f.warnings, []);
  });
}

test("repeated blocked evaluations leave an unchanged notice alone", async () => {
  const f = fixture();
  f.pr.labels.nodes.push({ name: "no-merge" });
  await f.run();
  await f.run();
  assert.equal(f.commentWrites.length, 1);
  assert.equal(f.commentWrites[0].method, "create");
  assert.deepEqual(f.merged, []);
});

test("a different blocker updates the same decision comment", async () => {
  const f = fixture();
  f.pr.labels.nodes.push({ name: "status/1-needs-review" });
  await f.run();
  f.pr.labels.nodes = [{ name: "needs-merge" }];
  f.pr.reviewDecision = "REVIEW_REQUIRED";
  await f.run();
  assert.equal(f.commentWrites.length, 2);
  assert.equal(f.commentWrites[1].method, "update");
  assert.equal(f.commentWrites[1].comment_id, 100);
  assert.match(f.commentWrites[1].body, /waiting for approval/);
  assert.deepEqual(f.merged, []);
});

for (const existing of [false, true]) {
  test(`a successful merge resolves an existing notice without creating one (existing: ${existing})`, async () => {
    const f = fixture();
    if (existing) f.comments.push({ id: 100, user: f.bot, body: `${commentMarker}\nMerge pending: waiting for approval.` });
    await f.run();
    assert.equal(f.merged.length, 1);
    assert.deepEqual(f.operations, ["merge", "removeLabel"]);
    assert.deepEqual(f.commentWrites, existing
      ? [{ method: "update", owner: "team", repo: "cairn", comment_id: 100, body: `${commentMarker}\nMerged.` }]
      : []);
    assert.deepEqual(f.warnings, []);
  });
}

for (const blocked of [false, true]) {
  test(`comment failures warn without changing the merge decision (blocked: ${blocked})`, async () => {
    const f = fixture();
    f.commentError = new Error("Comment service unavailable");
    if (blocked) f.pr.labels.nodes.push({ name: "no-merge" });
    else f.comments.push({ id: 100, user: f.bot, body: `${commentMarker}\nMerge pending.` });
    await f.run();
    assert.equal(f.merged.length, blocked ? 0 : 1);
    assert.equal(f.removedLabels.length, blocked ? 0 : 1);
    assert.deepEqual(f.commentWrites, []);
    assert.equal(f.warnings.length, 1);
    assert.match(f.warnings[0], /could not update the merge notice.*Comment service unavailable/);
  });
}

for (const patch of [{ state: "CLOSED" }, { baseRefName: "main" }, { baseRefName: "feat/parent" }]) {
  test(`does not create decision comments for an ineligible PR: ${JSON.stringify(patch)}`, async () => {
    const f = fixture();
    Object.assign(f.pr, patch);
    await f.run({ pull_request: f.candidates[0] });
    assert.deepEqual(f.commentWrites, []);
    assert.deepEqual(f.merged, []);
  });
}

test("a closed develop PR resolves its existing notice without requesting a merge", async () => {
  const f = fixture();
  f.pr.state = "CLOSED";
  f.comments.push({ id: 100, user: f.bot, body: `${commentMarker}\nMerge pending: waiting for approval.` });
  await f.run({ pull_request: f.candidates[0] });
  assert.deepEqual(f.merged, []);
  assert.deepEqual(f.removedLabels, []);
  assert.deepEqual(f.commentWrites, [{ method: "update", owner: "team", repo: "cairn", comment_id: 100,
    body: `${commentMarker}\nClosed without merging.` }]);
});

for (const commentFails of [false, true]) {
  test(`label-cleanup failures still resolve notices without masking the cleanup error (comment failure: ${commentFails})`, async () => {
    const f = fixture();
    f.cleanupError = Object.assign(new Error("Label cleanup forbidden"), { status: 403 });
    f.comments.push({ id: 100, user: f.bot, body: `${commentMarker}\nMerge pending.` });
    if (commentFails) f.commentError = new Error("Comment service unavailable");
    await assert.rejects(f.run(), /Label cleanup forbidden/);
    assert.equal(f.merged.length, 1);
    assert.deepEqual(f.operations, ["merge", "removeLabel"]);
    assert.deepEqual(f.commentWrites, commentFails ? [] : [{ method: "update", owner: "team", repo: "cairn",
      comment_id: 100, body: `${commentMarker}\nMerged.` }]);
    assert.equal(f.warnings.length, commentFails ? 1 : 0);
    if (commentFails) assert.match(f.warnings[0], /Comment service unavailable/);
  });
}

for (const patch of [
  { state: "CLOSED" }, { headRefOid: "new-head" }, { isDraft: true },
  { reviewDecision: "CHANGES_REQUESTED" }, { mergeStateStatus: "DIRTY" },
  { labels: { nodes: [{ name: "needs-merge" }] } },
]) {
  test(`does not post a queued notice after its PR snapshot changes: ${JSON.stringify(patch)}`, async () => {
    const f = fixture();
    f.pr.labels.nodes.push({ name: "no-merge" });
    f.snapshots = [structuredClone(f.pr), { ...structuredClone(f.pr), ...patch }];
    await f.run();
    assert.deepEqual(f.commentWrites, []);
    assert.deepEqual(f.merged, []);
    assert.deepEqual(f.warnings, []);
  });
}

test("a queued open notice is not revived after the PR closes and reopens during comment checks", async () => {
  const f = fixture();
  f.pr.labels.nodes.push({ name: "no-merge" });
  f.snapshots = [structuredClone(f.pr), { ...structuredClone(f.pr), state: "CLOSED" }];
  f.restCurrent = { state: "open", merged: false, base: { ref: "develop" }, head: { sha: "head" } };
  f.comments.push({ id: 100, user: f.bot, body: `${commentMarker}\nMerge pending: waiting for CI.` });
  await f.run();
  assert.deepEqual(f.commentWrites, []);
  assert.deepEqual(f.merged, []);
  assert.deepEqual(f.warnings, []);
});

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
    assert.deepEqual(f.removedLabels, []);
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
    assert.deepEqual(f.removedLabels, []);
  });
}

test("ignores periodic candidates without merge or review labels", async () => {
  const f = fixture();
  f.candidates[0].labels = [];
  await f.run();
  assert.equal(f.reads, 0);
});

test("reads current labels when the event snapshot lacks needs-merge", async () => {
  const f = fixture();
  await f.run({ pull_request: { ...f.candidates[0], labels: [] } });
  assert.equal(f.reads, 3);
  assert.equal(f.merged.length, 1);
});

test("does not merge an event PR whose current labels have no merge request", async () => {
  const f = fixture();
  f.pr.labels.nodes = [];
  await f.run({ pull_request: { ...f.candidates[0], labels: [] } });
  assert.equal(f.reads, 2);
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
      assert.equal(f.reads, 2);
      assert.equal(f.ciReads, 0);
      assert.deepEqual(f.merged, []);
      assert.deepEqual(f.removedLabels, []);
      assert.deepEqual(f.addedLabels, []);
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
  assert.equal(f.reads, 3);
  assert.equal(f.ciReads, 1);
  assert.deepEqual(f.merged, []);
  assert.deepEqual(f.removedLabels, []);
  assert.match(f.summary.items.join("\n"), /no-merge/);
});

for (const labels of [["needs-merge", "status/1-needs-review"], ["status/1-needs-review"]]) {
  for (const path of ["event", "periodic"]) {
    test(`needs-review blocks ${labels.join(" and ")} on the ${path} path without changing labels`, async () => {
      const f = fixture();
      f.pr.labels.nodes = labels.map(name => ({ name }));
      f.candidates[0].labels = labels.map(name => ({ name }));
      await f.run(path === "event" ? { pull_request: f.candidates[0] } : undefined);
      assert.equal(f.reads, 2);
      assert.equal(f.ciReads, 0);
      assert.deepEqual(f.merged, []);
      assert.deepEqual(f.removedLabels, []);
      assert.deepEqual(f.addedLabels, []);
      assert.match(f.messages.join("\n"), /status\/1-needs-review/);
      assert.match(f.summary.items.join("\n"), /status\/1-needs-review/);
    });
  }
}

test("needs-review added during CI lookup cancels an otherwise approved clean merge", async () => {
  const f = fixture();
  f.current = { ...f.pr, labels: { nodes: [{ name: "needs-merge" }, { name: "status/1-needs-review" }] } };
  await f.run({ pull_request: f.candidates[0] });
  assert.equal(f.reads, 3);
  assert.equal(f.ciReads, 1);
  assert.deepEqual(f.merged, []);
  assert.deepEqual(f.removedLabels, []);
  assert.deepEqual(f.addedLabels, []);
  assert.match(f.summary.items.join("\n"), /status\/1-needs-review/);
});

test("a maintainer's transition from needs-review to needs-merge permits a merge despite the stale event", async () => {
  const f = fixture();
  await f.run({ pull_request: { ...f.candidates[0], labels: [{ name: "status/1-needs-review" }] } });
  assert.equal(f.merged.length, 1);
  assert.deepEqual(f.removedLabels, [{ owner: "team", repo: "cairn", issue_number: 42, name: "needs-merge" }]);
  assert.deepEqual(f.addedLabels, []);
  assert.deepEqual(f.operations, ["merge", "removeLabel"]);
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
  assert.equal(f.reads, 3);
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
  assert.deepEqual(f.removedLabels, []);
  f.error = Object.assign(new Error("Merge requirements changed"), { status: 405 });
  await f.run();
  assert.deepEqual(f.removedLabels, []);
  f.error = Object.assign(new Error("Forbidden"), { status: 403 });
  await assert.rejects(f.run(), /Forbidden/);
  assert.deepEqual(f.removedLabels, []);
});

test("an unsuccessful merge response leaves needs-merge in place", async () => {
  const f = fixture();
  f.mergeResult = { merged: false, message: "Merge declined" };
  await assert.rejects(f.run(), /Merge declined/);
  assert.equal(f.merged.length, 1);
  assert.deepEqual(f.removedLabels, []);
  assert.deepEqual(f.addedLabels, []);
  assert.deepEqual(f.operations, ["merge"]);
});

test("a label already removed after a successful merge is an idempotent cleanup", async () => {
  const f = fixture();
  f.cleanupError = Object.assign(new Error("Label not found"), { status: 404 });
  await f.run();
  assert.equal(f.merged.length, 1);
  assert.deepEqual(f.removedLabels, [{ owner: "team", repo: "cairn", issue_number: 42, name: "needs-merge" }]);
  assert.deepEqual(f.operations, ["merge", "removeLabel"]);
  assert.equal(f.summary.writes, 1);
});

for (const status of [403, 405, 409, 500]) {
  test(`a ${status} cleanup failure is surfaced after merging rather than treated as a merge race`, async () => {
    const f = fixture();
    f.cleanupError = Object.assign(new Error(`Label cleanup failed (${status})`), { status });
    await assert.rejects(f.run(), /Label cleanup failed/);
    assert.equal(f.merged.length, 1);
    assert.deepEqual(f.removedLabels, [{ owner: "team", repo: "cairn", issue_number: 42, name: "needs-merge" }]);
    assert.deepEqual(f.operations, ["merge", "removeLabel"]);
    assert.deepEqual(f.addedLabels, []);
    assert.match(f.messages.join("\n"), /merged.*needs-merge cleanup failed/);
  });
}

for (const status of [undefined, 404]) {
  test(`an event for a confirmed merged develop PR retries only label cleanup (${status ?? "success"})`, async () => {
    const f = fixture();
    f.pr.state = "MERGED";
    f.pr.reviewDecision = null;
    f.pr.mergeStateStatus = "UNKNOWN";
    f.pr.labels.nodes.push({ name: "status/1-needs-review" });
    if (status) f.cleanupError = Object.assign(new Error("Label not found"), { status });
    await f.run({ pull_request: f.candidates[0] });
    assert.equal(f.reads, 2);
    assert.equal(f.ciReads, 0);
    assert.deepEqual(f.merged, []);
    assert.deepEqual(f.removedLabels, [{ owner: "team", repo: "cairn", issue_number: 42, name: "needs-merge" }]);
    assert.deepEqual(f.operations, ["removeLabel"]);
    assert.deepEqual(f.addedLabels, []);
  });
}

for (const [name, patch] of [
  ["closed without merging", { state: "CLOSED" }],
  ["merged to main", { state: "MERGED", baseRefName: "main" }],
  ["merged without a merge-request label", { state: "MERGED", labels: { nodes: [] } }],
]) {
  test(`an event for a PR ${name} does not clean up labels`, async () => {
    const f = fixture();
    Object.assign(f.pr, patch);
    await f.run({ pull_request: f.candidates[0] });
    assert.equal(f.ciReads, 0);
    assert.deepEqual(f.merged, []);
    assert.deepEqual(f.removedLabels, []);
    assert.deepEqual(f.addedLabels, []);
  });
}
