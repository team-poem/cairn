import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureReleasePullRequest } from "./release-pr.mjs";

test("an open release PR is preserved without any update call", async () => {
  const github = { rest: { pulls: {
    list: async args => {
      assert.equal(args.state, "open");
      assert.equal(args.base, "main");
      assert.equal(args.head, "team-poem:develop");
      return { data: [{ number: 273, title: "Human title", body: "Human notes" }] };
    },
  } } };
  assert.deepEqual(await ensureReleasePullRequest({ github, repo: { owner: "team-poem", repo: "cairn" }, version: "2.9.3", previous: "2.9.2" }), { number: 273, created: false });
});

test("no open release PR (including a closed predecessor) creates a draft with the previous version", async () => {
  const github = { rest: { pulls: {
    list: async () => ({ data: [] }),
    create: async args => {
      assert.equal(args.draft, true);
      assert.equal(args.title, "Release cairn-engine 2.9.3");
      assert.equal(args.head, "develop");
      assert.equal(args.base, "main");
      assert.match(args.body, /compare\/v2\.9\.2\.\.\.develop/);
      assert.doesNotMatch(args.body, /undefined/);
      return { data: { number: 280 } };
    },
  } } };
  assert.deepEqual(await ensureReleasePullRequest({ github, repo: { owner: "team-poem", repo: "cairn" }, version: "2.9.3", previous: "2.9.2", standingDays: "19", standingLast: "2026-09-12" }), { number: 280, created: true });
});

test("a missing previous version fails before calling GitHub", async () => {
  await assert.rejects(ensureReleasePullRequest({ github: {}, version: "2.9.3" }), /versions are required/);
});
