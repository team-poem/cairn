import test from "node:test";
import assert from "node:assert/strict";
import { postMergeDecisionComment } from "./merge-decision-comment.mjs";

const marker = "<!-- cairn-pingu-merge-decision -->";
const body = message => `${marker}\n${message}`;

function fixture() {
  const f = {
    repo: { owner: "team", repo: "cairn" },
    pr: { number: 42, state: "OPEN", baseRefName: "develop", headRefOid: "head",
      labels: { nodes: [{ name: "needs-merge" }] } },
    current: { state: "open", merged: false, base: { ref: "develop" }, head: { sha: "head" },
      labels: [{ name: "needs-merge" }] },
    bot: { id: 123, type: "Bot", login: "cairn-pingu[bot]" },
    pages: [[]], calls: [], sent: [], message: "Waiting for review.",
  };
  const called = name => {
    f.calls.push(name);
    if (f.failAt === name) throw new Error(`${name} unavailable`);
  };
  const github = {
    rest: {
      users: { getByUsername: async args => {
        called("bot");
        assert.deepEqual(args, { username: "cairn-pingu[bot]" });
        return { data: f.bot };
      } },
      pulls: { get: async args => {
        called("pr");
        assert.deepEqual(args, { ...f.repo, pull_number: 42 });
        return { data: f.current };
      } },
      issues: {
        listComments() {},
        createComment: async args => {
          called("create");
          f.sent.push({ method: "create", ...args });
          f.pages[0].push({ id: 100, user: f.bot, body: args.body });
          return { data: { id: 100 } };
        },
        updateComment: async args => {
          called("update");
          f.sent.push({ method: "update", ...args });
          f.pages.flat().find(comment => comment.id === args.comment_id).body = args.body;
          return { data: {} };
        },
      },
    },
    paginate: async (method, args) => {
      called("comments");
      assert.equal(method, github.rest.issues.listComments);
      assert.deepEqual(args, { ...f.repo, issue_number: 42, per_page: 100 });
      return f.pages.flat();
    },
  };
  f.publish = createIfMissing => postMergeDecisionComment({ github, context: { repo: f.repo },
    pr: f.pr, message: f.message, createIfMissing });
  f.ownComment = (message = "Waiting for CI.") => ({ id: 8, user: f.bot, body: body(message) });
  return f;
}

test("creates the first decision comment after verifying the bot and rereading the PR", async () => {
  const f = fixture();
  f.repo = { owner: "another-team", repo: "another-repo" };
  await f.publish();
  assert.deepEqual(f.sent, [{ method: "create", ...f.repo, issue_number: 42, body: body(f.message) }]);
  assert.deepEqual(f.calls, ["bot", "comments", "pr", "create"]);
});

test("repeated decisions do not create or update a comment again", async () => {
  const f = fixture();
  await f.publish();
  await f.publish();
  assert.equal(f.sent.length, 1);
  assert.equal(f.calls.filter(call => call === "pr").length, 2);
});

test("updates a changed reason in the existing bot comment", async () => {
  const f = fixture();
  f.pages = [[f.ownComment()]];
  await f.publish();
  assert.deepEqual(f.sent, [{ method: "update", ...f.repo, comment_id: 8, body: body(f.message) }]);
  assert.deepEqual(f.calls, ["bot", "comments", "pr", "update"]);
});

for (const labels of [[], ["needs-review"], ["status/1-needs-review"], ["no-merge"], ["Needs-Merge"]]) {
  for (const existing of [false, true]) {
    test(`does not publish an open decision without exact needs-merge: ${JSON.stringify({ labels, existing })}`, async () => {
      const f = fixture();
      f.pr.labels.nodes = labels.map(name => ({ name }));
      if (existing) f.pages = [[f.ownComment()]];
      await f.publish();
      assert.deepEqual(f.sent, []);
      assert.deepEqual(f.calls, []);
      if (existing) assert.equal(f.pages[0][0].body, body("Waiting for CI."));
    });
  }
}

for (const existing of [false, true]) {
  test(`a final label reread suppresses a cancelled request (existing: ${existing})`, async () => {
    const f = fixture();
    f.current.labels = [{ name: "no-merge" }];
    if (existing) f.pages = [[f.ownComment()]];
    await f.publish();
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.calls, ["bot", "comments", "pr"]);
    if (existing) assert.equal(f.pages[0][0].body, body("Waiting for CI."));
  });
}

test("updates only the marked comment owned by the verified numeric bot ID across all pages", async () => {
  const f = fixture();
  f.pages = [
    [{ id: 1, user: { id: 999, type: "User", login: "human" }, body: marker }],
    [{ id: 2, user: { ...f.bot, id: 456 }, body: marker },
      { id: 3, user: f.bot, body: "Unrelated bot comment." }],
    [f.ownComment()],
  ];
  await f.publish();
  assert.deepEqual(f.sent, [{ method: "update", ...f.repo, comment_id: 8, body: body(f.message) }]);
  assert.equal(f.pages[0][0].body, marker);
  assert.equal(f.pages[1][0].body, marker);
  assert.equal(f.pages[1][1].body, "Unrelated bot comment.");
});

test("creates its own comment without rewriting human or other-bot marker comments", async () => {
  const f = fixture();
  f.pages = [[
    { id: 1, user: { id: 999, type: "User", login: "human" }, body: body("Human note.") },
    { id: 2, user: { ...f.bot, id: 456 }, body: body("Another bot note.") },
  ]];
  await f.publish();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].method, "create");
  assert.equal(f.pages[0][0].body, body("Human note."));
  assert.equal(f.pages[0][1].body, body("Another bot note."));
});

for (const patch of [
  { type: "User" }, { login: "other[bot]" }, { id: 0 }, { id: -1 },
  { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { id: "123" },
]) {
  test(`rejects an unverified bot identity: ${JSON.stringify(patch)}`, async () => {
    const f = fixture();
    Object.assign(f.bot, patch);
    await assert.rejects(f.publish(), /bot identity/);
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.calls, ["bot"]);
  });
}

for (const [name, change] of [
  ["head changed", f => { f.current.head.sha = "new-head"; }],
  ["base moved away from develop", f => { f.current.base.ref = "main"; }],
  ["snapshot did not target develop", f => { f.pr.baseRefName = "main"; }],
  ["closed snapshot was reopened", f => { f.pr.state = "CLOSED"; }],
  ["merged snapshot was reopened", f => { f.pr.state = "MERGED"; }],
]) {
  test(`skips a stale decision when the ${name}`, async () => {
    const f = fixture();
    f.pages = [[f.ownComment()]];
    change(f);
    await f.publish();
    assert.deepEqual(f.sent, []);
    assert.equal(f.pages[0][0].body, body("Waiting for CI."));
  });
}

for (const [name, merged, message] of [
  ["merged", true, "Merged."],
  ["closed without merging", false, "Closed without merging."],
]) {
  test(`resolves only an existing comment when the PR is ${name}`, async () => {
    const f = fixture();
    f.current.state = "closed";
    f.current.merged = merged;
    f.pages = [[f.ownComment()]];
    await f.publish();
    assert.deepEqual(f.sent, [{ method: "update", ...f.repo, comment_id: 8, body: body(message) }]);
    await f.publish();
    assert.equal(f.sent.length, 1);
  });

  test(`does not create a new decision comment after the PR is ${name}`, async () => {
    const f = fixture();
    f.current.state = "closed";
    f.current.merged = merged;
    await f.publish();
    assert.deepEqual(f.sent, []);
  });

  for (const existing of [false, true]) {
    test(`a ${name} snapshot can only resolve an existing notice without needs-merge (existing: ${existing})`, async () => {
      const f = fixture();
      f.pr.state = merged ? "MERGED" : "CLOSED";
      f.pr.labels.nodes = [];
      f.current.state = "closed";
      f.current.merged = merged;
      f.current.labels = [];
      if (existing) f.pages = [[f.ownComment()]];
      await f.publish();
      assert.deepEqual(f.sent, existing
        ? [{ method: "update", ...f.repo, comment_id: 8, body: body(message) }]
        : []);
    });
  }
}

test("createIfMissing false leaves an uncommented open PR alone but can update an existing comment", async () => {
  const f = fixture();
  await f.publish(false);
  assert.deepEqual(f.sent, []);
  f.pages = [[f.ownComment()]];
  await f.publish(false);
  assert.deepEqual(f.sent, [{ method: "update", ...f.repo, comment_id: 8, body: body(f.message) }]);
});

for (const source of ["bot", "comments", "pr", "create", "update"]) {
  test(`propagates a ${source} API failure to the caller`, async () => {
    const f = fixture();
    f.failAt = source;
    if (source === "update") f.pages = [[f.ownComment()]];
    await assert.rejects(f.publish(), new RegExp(`${source} unavailable`));
    assert.deepEqual(f.sent, []);
  });
}
