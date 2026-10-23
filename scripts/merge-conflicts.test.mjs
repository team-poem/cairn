import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeDevelopInto, resolveContained } from "./merge-conflicts.mjs";

const git = (cwd, ...args) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
const block = (pr, base, dev) => `a\n<<<<<<< HEAD\n${pr}||||||| base\n${base}=======\n${dev}>>>>>>> origin/develop\nz\n`;

test("keeps develop when the pull request side adds nothing develop lacks", () => {
  assert.equal(resolveContained(block("", "", "x\n")), "a\nx\nz\n");
  assert.equal(resolveContained(block("x\n", "", "x\ny\n")), "a\nx\ny\nz\n");
  assert.equal(resolveContained(block("x\nw\n", "", "x\ny\nw\n")), "a\nx\ny\nw\nz\n");
  assert.equal(resolveContained(block("b\n", "b\n", "c\n")), "a\nc\nz\n");
  assert.equal(resolveContained(block("c\n", "b\n", "b\n")), "a\nc\nz\n");
});

test("leaves a real conflict, including a pull request deletion, to a person", () => {
  assert.equal(resolveContained(block("x\n", "", "y\n")), null);
  assert.equal(resolveContained(block("w\nx\n", "", "x\ny\nw\n")), null);
  assert.equal(resolveContained(block("", "b\n", "c\n")), null);
  assert.equal(resolveContained(block("x\n", "b\n", "x\nc\n")), null);
  assert.equal(resolveContained("no conflict\n"), null);
});

async function repo(t, prLines, devLines, prOnly = false) {
  const root = await mkdtemp(join(tmpdir(), "cairn-merge-conflicts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  git(root, "init", "--quiet", "--bare", "-b", "develop", origin);
  git(root, "clone", "--quiet", origin, work);
  for (const [k, v] of [["user.name", "Test"], ["user.email", "test@example.test"], ["commit.gpgsign", "false"]]) git(work, "config", k, v);
  const commit = async (lines, message) => {
    await writeFile(join(work, "list.txt"), ["a", ...lines, "z", ""].join("\n"));
    git(work, "commit", "--quiet", "-am", message);
  };
  await writeFile(join(work, "list.txt"), "a\nz\n");
  git(work, "add", "list.txt");
  git(work, "commit", "--quiet", "-m", "base");
  git(work, "push", "--quiet", "origin", "HEAD:develop");
  git(work, "switch", "--quiet", "-c", "feature");
  if (prOnly) {
    await writeFile(join(work, "other.txt"), "only in the pull request\n");
    git(work, "add", "other.txt");
  }
  await commit(prLines, "pr");
  git(work, "push", "--quiet", "origin", "HEAD:feature", "HEAD:refs/pull/7/head");
  const head = git(work, "rev-parse", "HEAD");
  git(work, "switch", "--quiet", "develop");
  await commit(devLines, "develop");
  git(work, "push", "--quiet", "origin", "HEAD:develop");
  return { origin, work, head, run: () => mergeDevelopInto({ cwd: work, number: 7, ref: "feature", head }) };
}

test("a branch already contained in develop is reported landed and left untouched", async t => {
  const r = await repo(t, ["x"], ["x", "y"]);
  assert.deepEqual(r.run(), { kind: "landed" });
  assert.equal(git(r.origin, "rev-parse", "feature"), r.head);
});

test("a resolvable conflict is pushed as a merge commit on top of the reviewed head", async t => {
  const r = await repo(t, ["x"], ["x", "y"], true);
  const result = r.run();
  assert.equal(result.kind, "resolved");
  assert.equal(git(r.origin, "rev-parse", "feature"), result.sha);
  assert.equal(git(r.origin, "rev-parse", `${result.sha}^1`), r.head);
  assert.equal(git(r.origin, "show", `${result.sha}:list.txt`), "a\nx\ny\nz");
  assert.equal(git(r.origin, "show", `${result.sha}:other.txt`), "only in the pull request");
});

test("a real conflict pushes nothing", async t => {
  const r = await repo(t, ["x", "p"], ["x", "y"]);
  assert.deepEqual(r.run(), { kind: "conflict" });
  assert.equal(git(r.origin, "rev-parse", "feature"), r.head);
});

test("a moved branch is not updated", async t => {
  const r = await repo(t, ["x"], ["x", "y"]);
  assert.deepEqual(mergeDevelopInto({ cwd: r.work, number: 7, ref: "feature", head: "0".repeat(40) }), { kind: "changed" });
});
