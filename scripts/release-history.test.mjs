import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertReleaseHistory } from "./release-history.mjs";

const git = (cwd, ...args) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "cairn-release-history-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.test");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "commit", "--allow-empty", "-m", "baseline");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(dir, "switch", "-c", "develop");
  await writeFile(join(dir, "feature.txt"), "release content\n");
  git(dir, "add", "feature.txt");
  git(dir, "commit", "-m", "feature");
  return dir;
}
function release(dir, squash = false) {
  git(dir, "switch", "main");
  if (squash) {
    git(dir, "merge", "--squash", "develop");
    git(dir, "commit", "-m", "squashed release");
  } else git(dir, "merge", "--no-ff", "develop", "-m", "release merge");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(dir, "switch", "develop");
}

test("main already in develop is accepted without modifying the checkout", async t => {
  const dir = await fixture(t);
  const before = git(dir, "rev-parse", "HEAD");
  assertReleaseHistory(dir);
  assert.equal(git(dir, "rev-parse", "HEAD"), before);
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("normal release merges allow the next cycle without a back-merge", async t => {
  const dir = await fixture(t);
  release(dir);
  git(dir, "commit", "--allow-empty", "-m", "next cycle");
  assertReleaseHistory(dir);
  release(dir);
  git(dir, "commit", "--allow-empty", "-m", "third cycle");
  assertReleaseHistory(dir);
});

test("a squash release is rejected even when its tree exactly matches develop", async t => {
  const dir = await fixture(t);
  release(dir, true);
  assert.equal(git(dir, "rev-parse", "main^{tree}"), git(dir, "rev-parse", "HEAD^{tree}"));
  assert.throws(() => assertReleaseHistory(dir), /main history is not connected.*squash\/rebase/);
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("a rebased release is rejected even when the resulting files are identical", async t => {
  const dir = await fixture(t);
  const feature = git(dir, "rev-parse", "HEAD");
  git(dir, "switch", "main");
  git(dir, "commit", "--allow-empty", "-m", "main-only history");
  git(dir, "cherry-pick", feature);
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(dir, "switch", "develop");
  assert.equal(git(dir, "rev-parse", "main^{tree}"), git(dir, "rev-parse", "HEAD^{tree}"));
  assert.throws(() => assertReleaseHistory(dir), /main history is not connected/);
});

test("a history repair merge resolves the squash case while preserving the develop tree", async t => {
  const dir = await fixture(t);
  release(dir, true);
  const before = git(dir, "rev-parse", "HEAD^{tree}");
  git(dir, "merge", "--no-ff", "main", "-m", "repair release ancestry");
  assertReleaseHistory(dir);
  assert.equal(git(dir, "rev-parse", "HEAD^{tree}"), before);
  assert.equal(git(dir, "merge-base", "main", "HEAD"), git(dir, "rev-parse", "main"));
});

test("later main-only commits must be synchronized rather than silently skipped", async t => {
  const dir = await fixture(t);
  release(dir);
  git(dir, "switch", "main");
  git(dir, "commit", "--allow-empty", "-m", "main hotfix");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(dir, "switch", "develop");
  assert.throws(() => assertReleaseHistory(dir), /main-only changes/);
});

test("a two-parent merge of an unrelated branch is not mistaken for a release", async t => {
  const dir = await fixture(t);
  git(dir, "switch", "-c", "other", "main");
  git(dir, "commit", "--allow-empty", "-m", "other change");
  git(dir, "switch", "main");
  git(dir, "merge", "--no-ff", "other", "-m", "not a develop release");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(dir, "switch", "develop");
  assert.throws(() => assertReleaseHistory(dir), /main history is not connected/);
});

test("missing and shallow history fail with fetch instructions", async t => {
  const dir = await fixture(t);
  git(dir, "update-ref", "-d", "refs/remotes/origin/main");
  assert.throws(() => assertReleaseHistory(dir), /origin\/main is missing.*Fetch/);
  const shallow = join(dir, "shallow");
  git(dir, "clone", "--depth", "1", "--branch", "main", pathToFileURL(dir).href, shallow);
  assert.throws(() => assertReleaseHistory(shallow), /history is shallow.*Fetch/);
});
