import test from "node:test";
import assert from "node:assert/strict";
import { checkMergeLabelPolicy, mergeLabelBlocker } from "./merge-label-policy.mjs";

const labels = (...names) => ({ nodes: names.map(name => ({ name })), pageInfo: { hasNextPage: false } });
const pullRequest = number => ({ number, state: "OPEN", baseRefName: "develop", headRefOid: "head",
  labels: labels("needs-merge") });
const candidate = (number, sha = "head") => ({ number, head: { sha } });

function fixture() {
  const f = {
    repo: { owner: "team", repo: "cairn" },
    event: { number: 42, head: { sha: "head" }, labels: [{ name: "needs-merge" }] },
    prs: new Map([[42, pullRequest(42)]]), current: new Map(), reads: new Map(),
    pages: [[candidate(42)]], listCalls: [], failed: [], messages: [],
    summary: { headings: [], items: [], writes: 0 },
  };
  const github = {
    graphql: async (query, args) => {
      if (f.readError) throw f.readError;
      assert.match(query, /pullRequest/);
      assert.deepEqual(args, { ...f.repo, number: args.number });
      const count = (f.reads.get(args.number) ?? 0) + 1;
      f.reads.set(args.number, count);
      const pr = count > 1 && f.current.has(args.number) ? f.current.get(args.number) : f.prs.get(args.number);
      return { repository: { pullRequest: pr ?? null } };
    },
    rest: { pulls: { list() {} } },
    paginate: async (method, args) => {
      assert.equal(method, github.rest.pulls.list);
      assert.deepEqual(args, { ...f.repo, state: "open", base: "develop", per_page: 100 });
      f.listCalls.push(args);
      if (f.listError) throw f.listError;
      return (f.listCalls.length > 1 && f.finalPages ? f.finalPages : f.pages).flat();
    },
  };
  const summary = {
    addHeading(heading) { f.summary.headings.push(heading); return this; },
    addList(items) { f.summary.items.push(...items); return this; },
    async write() { f.summary.writes++; },
  };
  f.run = () => checkMergeLabelPolicy({ github,
    context: { repo: f.repo, payload: { pull_request: f.event } },
    core: { setFailed(message) { f.failed.push(message); }, info(message) { f.messages.push(message); }, summary },
  });
  return f;
}

test("the shared blocker requires a merge request and gives blocking labels precedence", () => {
  const pr = pullRequest(42);
  assert.equal(mergeLabelBlocker(pr), null);
  pr.labels = labels();
  assert.equal(mergeLabelBlocker(pr), "no needs-merge request is active.");
  pr.labels = labels("status/1-needs-review");
  assert.match(mergeLabelBlocker(pr), /blocked by status\/1-needs-review/);
  pr.labels = labels("needs-merge", "status/1-needs-review", "no-merge");
  assert.match(mergeLabelBlocker(pr), /^blocked by no-merge/);
});

test("passes only after checking every same-head develop PR twice in the current repository", async () => {
  const f = fixture();
  f.repo = { owner: "another-team", repo: "another-repo" };
  f.prs.set(73, pullRequest(73));
  f.pages = [[candidate(42), candidate(73)]];
  await f.run();
  assert.deepEqual(f.failed, []);
  assert.equal(f.reads.get(42), 2);
  assert.equal(f.reads.get(73), 2);
  assert.ok(f.listCalls.length > 0);
});

for (const [name, currentLabels, reason] of [
  ["no-merge", labels("needs-merge", "no-merge", "status/1-needs-review"), /no-merge/],
  ["pending review", labels("needs-merge", "status/1-needs-review"), /status\/1-needs-review/],
  ["incomplete labels", { ...labels("needs-merge"), pageInfo: { hasNextPage: true } }, /incomplete/],
  ["incomplete labels without a visible request", { ...labels(), pageInfo: { hasNextPage: true } }, /incomplete/],
]) {
  test(`fails the merge-request label check when the live PR has ${name}`, async () => {
    const f = fixture();
    f.prs.get(42).labels = currentLabels;
    await f.run();
    assert.ok(f.failed.length > 0);
    assert.match(f.failed.join("\n"), reason);
  });
}

for (const names of [[], ["status/1-needs-review"], ["no-merge"], ["Needs-Merge"]]) {
  for (const stage of ["initial", "final"]) {
    test(`does not fail a cancelled request on the ${stage} read: ${JSON.stringify(names)}`, async () => {
      const f = fixture();
      const cancelled = { ...pullRequest(42), labels: labels(...names) };
      if (stage === "initial") f.prs.set(42, cancelled);
      else f.current.set(42, cancelled);
      await f.run();
      assert.deepEqual(f.failed, []);
      assert.equal(f.reads.get(42), stage === "initial" ? 1 : 2);
      assert.match(f.messages.join("\n"), /needs-merge/);
      assert.match(f.summary.items.join("\n"), /needs-merge/);
      assert.equal(f.summary.writes, 1);
    });
  }
}

for (const blocker of ["status/1-needs-review", "no-merge"]) {
  test(`a blocked request cancelled before the final read does not fail: ${blocker}`, async () => {
    const f = fixture();
    f.prs.get(42).labels = labels("needs-merge", blocker);
    f.current.set(42, { ...pullRequest(42), labels: labels(blocker) });
    await f.run();
    assert.deepEqual(f.failed, []);
    assert.equal(f.reads.get(42), 2);
    assert.match(f.messages.join("\n"), /needs-merge/);
  });
}

test("uses live labels instead of a blocked event snapshot", async () => {
  const f = fixture();
  f.event.labels = [{ name: "no-merge" }, { name: "status/1-needs-review" }];
  await f.run();
  assert.deepEqual(f.failed, []);
  assert.equal(f.reads.get(42), 2);
});

for (const [name, patch] of [
  ["head changes", { headRefOid: "new-head" }],
  ["review label returns", { labels: labels("needs-merge", "status/1-needs-review") }],
]) {
  test(`fails when the ${name} on the final read`, async () => {
    const f = fixture();
    f.current.set(42, { ...pullRequest(42), ...patch });
    await f.run();
    assert.ok(f.failed.length > 0);
    assert.equal(f.reads.get(42), 2);
  });
}

test("fails closed when the triggering PR is unavailable", async () => {
  const f = fixture();
  f.prs.delete(42);
  await f.run();
  assert.ok(f.failed.length > 0);
});

test("a requested second PR sharing the head cannot borrow a passing label check", async () => {
  const f = fixture();
  f.prs.set(73, { ...pullRequest(73), labels: labels("needs-merge", "no-merge") });
  f.pages = [[candidate(42), candidate(73)]];
  await f.run();
  assert.ok(f.failed.length > 0);
  assert.match(f.failed.join("\n"), /73.*no-merge/);
});

test("re-enumerates before success to catch a newly opened blocked PR sharing the head", async () => {
  const f = fixture();
  f.prs.set(73, { ...pullRequest(73), labels: labels("needs-merge", "no-merge") });
  f.finalPages = [[candidate(42)], [candidate(73)]];
  await f.run();
  assert.equal(f.listCalls.length, 2);
  assert.equal(f.reads.get(42), 2);
  assert.equal(f.reads.get(73), 1);
  assert.ok(f.failed.length > 0);
  assert.match(f.failed.join("\n"), /73 \(final check\).*no-merge/);
});

for (const names of [["status/1-needs-review"], ["no-merge"]]) {
  test(`an unrequested same-head PR does not block a requested merge: ${names[0]}`, async () => {
    const f = fixture();
    f.prs.set(73, { ...pullRequest(73), labels: labels(...names) });
    f.pages = [[candidate(42), candidate(73)]];
    await f.run();
    assert.deepEqual(f.failed, []);
    assert.equal(f.reads.get(42), 2);
    assert.equal(f.reads.get(73), 2);
  });
}

test("a same-head sibling can cancel its request before the final check", async () => {
  const f = fixture();
  f.prs.set(73, pullRequest(73));
  f.current.set(73, { ...pullRequest(73), labels: labels("no-merge") });
  f.pages = [[candidate(42), candidate(73)]];
  await f.run();
  assert.deepEqual(f.failed, []);
  assert.equal(f.reads.get(73), 2);
});

test("a blocked same-head sibling can cancel its request before the final check", async () => {
  const f = fixture();
  f.prs.set(73, { ...pullRequest(73), labels: labels("needs-merge", "no-merge") });
  f.current.set(73, { ...pullRequest(73), labels: labels("no-merge") });
  f.pages = [[candidate(42), candidate(73)]];
  await f.run();
  assert.deepEqual(f.failed, []);
  assert.equal(f.reads.get(73), 2);
});

test("a cancelled triggering request stops before evaluating requested same-head siblings", async () => {
  const f = fixture();
  f.prs.get(42).labels = labels("status/1-needs-review");
  f.prs.set(73, { ...pullRequest(73), labels: labels("needs-merge", "no-merge") });
  f.pages = [[candidate(42), candidate(73)]];
  await f.run();
  assert.deepEqual(f.failed, []);
  assert.equal(f.reads.has(73), false);
});

test("a blocked PR at a different head does not block the triggering head", async () => {
  const f = fixture();
  f.prs.set(73, { ...pullRequest(73), headRefOid: "other-head", labels: labels("no-merge") });
  f.pages = [[candidate(42), candidate(73, "other-head")]];
  await f.run();
  assert.deepEqual(f.failed, []);
  assert.equal(f.reads.has(73), false);
});

test("finds a blocked same-head PR beyond the first listing page", async () => {
  const f = fixture();
  f.prs.set(73, { ...pullRequest(73), labels: labels("needs-merge", "status/1-needs-review") });
  f.pages = [[candidate(42)], [candidate(71, "unrelated-head")], [candidate(73)]];
  await f.run();
  assert.ok(f.failed.length > 0);
  assert.match(f.failed.join("\n"), /73.*status\/1-needs-review/);
});

for (const [name, patch] of [
  ["has moved to another head", { headRefOid: "new-head" }],
  ["is closed", { state: "CLOSED" }],
  ["targets main", { baseRefName: "main" }],
]) {
  for (const requested of [false, true]) {
    test(`fails when the live triggering PR ${name} (requested: ${requested})`, async () => {
      const f = fixture();
      Object.assign(f.prs.get(42), patch);
      if (!requested) f.prs.get(42).labels = labels();
      await f.run();
      assert.ok(f.failed.length > 0);
    });
  }
}

for (const source of ["readError", "listError"]) {
  test(`an unavailable ${source === "readError" ? "PR lookup" : "paginated PR listing"} cannot pass the check`, async () => {
    const f = fixture();
    f[source] = new Error("GitHub unavailable");
    await assert.rejects(f.run(), /GitHub unavailable/);
  });
}
