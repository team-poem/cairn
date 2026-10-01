import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushPreparedRelease } from "./release-push.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const unpublished = { published: async () => false };
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "cairn-release-push-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git"), local = join(root, "local");
  git(root, "init", "--bare", remote);
  git(root, "init", "-b", "develop", local);
  git(local, "config", "user.name", "Test");
  git(local, "config", "user.email", "test@example.test");
  git(local, "config", "commit.gpgsign", "false");
  await mkdir(join(local, "packages/harness"), { recursive: true });
  await mkdir(join(local, "spec/journal/entries"), { recursive: true });
  await writeFile(join(local, "packages/harness/package.json"), '{"version":"2.9.3"}\n');
  await writeFile(join(local, "package-lock.json"), '{}\n');
  await writeFile(join(local, "spec/journal/entries/.gitkeep"), '');
  git(local, "add", ".");
  git(local, "commit", "-m", "initial");
  git(local, "remote", "add", "origin", remote);
  git(local, "push", "-u", "origin", "develop");
  return { root, remote, local };
}

test("unchanged preparation creates neither a commit nor a push", async t => {
  const { local, remote } = await setup(t);
  const before = git(local, "rev-parse", "HEAD");
  assert.match(await pushPreparedRelease(local, "2.9.3", unpublished), /No release file changes/);
  assert.equal(git(local, "rev-parse", "HEAD"), before);
  assert.equal(git(remote, "rev-parse", "develop"), before);
});

test("a refresh pushes only the release files", async t => {
  const { local, remote } = await setup(t);
  await writeFile(join(local, "spec/journal/entries/note.md"), "new journal\n");
  await writeFile(join(local, "unrelated.txt"), "do not commit\n");
  await pushPreparedRelease(local, "2.9.3", unpublished);
  assert.equal(git(remote, "rev-parse", "develop"), git(local, "rev-parse", "HEAD"));
  assert.equal(git(local, "diff", "HEAD^", "HEAD", "--name-only"), "spec/journal/entries/note.md");
});

test("a racing journal push is retained and stale preparation fails without a local commit", async t => {
  const { root, local, remote } = await setup(t);
  const other = join(root, "journal");
  git(root, "clone", "--branch", "develop", remote, other);
  await writeFile(join(other, "spec/journal/entries/late.md"), "late journal\n");
  git(other, "add", ".");
  git(other, "-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "late journal");
  git(other, "push", "origin", "develop");
  const before = git(local, "rev-parse", "HEAD");
  await writeFile(join(local, "package-lock.json"), '{"prepared":true}\n');
  await assert.rejects(pushPreparedRelease(local, "2.9.3", unpublished), /develop changed during preparation/);
  assert.equal(git(local, "rev-parse", "HEAD"), before);
  assert.equal(git(remote, "show", "develop:spec/journal/entries/late.md"), "late journal");
  assert.equal(await readFile(join(local, "package-lock.json"), "utf8"), '{"prepared":true}\n');
});

test("publication that happens during checks prevents the preparation push", async t => {
  const { local, remote } = await setup(t);
  const before = git(local, "rev-parse", "HEAD");
  await writeFile(join(local, "package-lock.json"), '{"prepared":true}\n');
  await assert.rejects(pushPreparedRelease(local, "2.9.3", { published: async () => true }), /already released/);
  assert.equal(git(remote, "rev-parse", "develop"), before);
  assert.equal(git(local, "rev-parse", "HEAD"), before);
});
