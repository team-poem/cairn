import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRelease, isPublished } from "./release-prepare.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/** A scratch repository: the two scripts, a manifest, a lockfile and an empty journal. */
async function sandbox(t, { version = "2.9.0", lock } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cairn-release-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "scripts"), { recursive: true });
  await mkdir(join(dir, "spec/journal/entries"), { recursive: true });
  await mkdir(join(dir, "packages/harness"), { recursive: true });
  for (const name of ["journal.mjs", "release-prepare.mjs"]) await cp(join(root, "scripts", name), join(dir, "scripts", name));
  await writeFile(join(dir, "packages/harness/package.json"), `${JSON.stringify({ name: "cairn-engine", version, main: "dist/index.js" }, null, 2)}\n`);
  await writeFile(join(dir, "package-lock.json"), `${JSON.stringify(lock ?? {
    name: "cairn", lockfileVersion: 3,
    packages: {
      "": { name: "cairn", workspaces: ["packages/*"] },
      "packages/harness": { name: "cairn-engine", version },
      // A dependency that happens to share the version. A string replacement rewrites this too and
      // leaves resolved and integrity pointing at the old one, which npm ci accepts in silence.
      "node_modules/tinybench": { version, resolved: `https://registry.npmjs.org/tinybench/-/tinybench-${version}.tgz`, integrity: "sha512-fixture" },
    },
  }, null, 2)}\n`);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "initial"], { cwd: dir });
  return dir;
}
const run = (dir, args) => prepareRelease(dir, args[1], { published: async () => false });
const fails = async (dir, args) => {
  try { await run(dir, args); return null; }
  catch (error) { return error.message; }
};
const read = async (dir, path) => JSON.parse(await readFile(join(dir, path), "utf8"));

test("releasePrepareBumpsOnlyTheHarnessEntries", async (t) => {
  const dir = await sandbox(t);
  await run(dir, ["scripts/release-prepare.mjs", "2.10.0"]);
  assert.equal((await read(dir, "packages/harness/package.json")).version, "2.10.0");
  const lock = await read(dir, "package-lock.json");
  assert.equal(lock.packages["packages/harness"].version, "2.10.0");
  // The dependency that shared the version must not move, or its integrity hash becomes a lie.
  assert.equal(lock.packages["node_modules/tinybench"].version, "2.9.0");
  assert.match(lock.packages["node_modules/tinybench"].resolved, /tinybench-2\.9\.0\.tgz/);
});

test("releasePrepareRefusesToGoBackwardsOrNowhere", async (t) => {
  const dir = await sandbox(t);
  assert.match(await fails(dir, ["scripts/release-prepare.mjs", "2.9.0"]) ?? "", /already 2\.9\.0/);
  assert.match(await fails(dir, ["scripts/release-prepare.mjs", "2.8.0"]) ?? "", /below the current 2\.9\.0/);
  assert.match(await fails(dir, ["scripts/release-prepare.mjs", "2.8.9"]) ?? "", /below the current/);
  assert.match(await fails(dir, ["scripts/release-prepare.mjs", "latest"]) ?? "", /Usage/);
  // A refusal must leave the manifest alone, so a retry starts from a clean state.
  assert.equal((await read(dir, "packages/harness/package.json")).version, "2.9.0");
});

test("releasePrepareRefusesALockfileThatDoesNotCarryTheCurrentVersion", async (t) => {
  const dir = await sandbox(t, { lock: { packages: { "": {}, "packages/harness": { version: "2.7.0" } } } });
  assert.match(await fails(dir, ["scripts/release-prepare.mjs", "2.10.0"]) ?? "", /does not carry packages\/harness at 2\.9\.0/);
  assert.equal((await read(dir, "packages/harness/package.json")).version, "2.9.0");
});

test("releasePrepareFoldsItsOwnEntryIntoTheArchiveItDescribes", async (t) => {
  const dir = await sandbox(t);
  await writeFile(join(dir, "spec/journal/entries/2026-01-01-earlier.md"),
    "---\nissue: 7\nstatus: landed\nsummary: An earlier thing\nnext: null\n---\n\n# An earlier thing\n\nBody.\n");
  await run(dir, ["scripts/release-prepare.mjs", "2.10.0"]);
  const archived = await readFile(join(dir, "spec/journal/archive/2.10.0.md"), "utf8");
  // The order matters: written before the fold, or the release's own record lands next cycle.
  assert.match(archived, /## Release 2\.10\.0/);
  assert.match(archived, /## An earlier thing/);
  assert.deepEqual((await readdir(join(dir, "spec/journal/entries"))).filter((n) => n.endsWith(".md")), []);
});

test("releasePrepareCreatesTheEntriesDirectoryWhenAFoldRemovedIt", async (t) => {
  const dir = await sandbox(t);
  await rm(join(dir, "spec/journal/entries"), { recursive: true, force: true });
  await run(dir, ["scripts/release-prepare.mjs", "2.10.0"]);
  assert.match(await readFile(join(dir, "spec/journal/archive/2.10.0.md"), "utf8"), /## Release 2\.10\.0/);
});

const late = "---\nissue: 276\npr: 278\nstatus: landed\nsummary: README follow-up\nnext: null\n---\n\nKeep the evidence.\n";
const lateName = "spec/journal/entries/2026-10-01-276-pr-278.md";

test("refresh preserves human edits, folds late entries once and then does nothing", async t => {
  const dir = await sandbox(t);
  await run(dir, ["scripts/release-prepare.mjs", "2.10.0"]);
  const path = join(dir, "spec/journal/archive/2.10.0.md");
  const edited = (await readFile(path, "utf8")).replace("Replace this paragraph with what the release is about, and say plainly what it does not do.", "Human release decision.");
  await writeFile(path, edited);
  await writeFile(join(dir, lateName), late);
  const result = await run(dir, ["scripts/release-prepare.mjs", "2.10.0"]);
  assert.equal(result.previous, "2.9.0");
  assert.equal(result.refresh, true);
  const refreshed = await readFile(path, "utf8");
  assert(refreshed.startsWith(edited));
  assert.equal(refreshed.split("## README follow-up").length - 1, 1);
  assert.equal(refreshed.split("## Release 2.10.0").length - 1, 1);
  const noop = await run(dir, ["scripts/release-prepare.mjs", "2.10.0"]);
  assert.equal(noop.message, "No new journal entries.");
  assert.equal(await readFile(path, "utf8"), refreshed);
});

test("refresh accepts the legacy prepared archive format used by 2.9.3", async t => {
  const dir = await sandbox(t, { version: "2.9.3" });
  await mkdir(join(dir, "spec/journal/archive"));
  const original = await readFile(join(root, "spec/journal/archive/2.9.3.md"), "utf8");
  await writeFile(join(dir, "spec/journal/archive/2.9.3.md"), original);
  await writeFile(join(dir, lateName), late);
  assert.equal((await run(dir, ["scripts/release-prepare.mjs", "2.9.3"])).previous, "2.9.2");
  assert((await readFile(join(dir, "spec/journal/archive/2.9.3.md"), "utf8")).startsWith(original));
});

test("retry after archival but before cleanup does not append the entry again", async t => {
  const dir = await sandbox(t);
  await writeFile(join(dir, lateName), late);
  await run(dir, ["scripts/release-prepare.mjs", "2.10.0"]);
  const path = join(dir, "spec/journal/archive/2.10.0.md");
  const original = await readFile(path, "utf8");
  await writeFile(join(dir, lateName), late);
  await run(dir, ["scripts/release-prepare.mjs", "2.10.0"]);
  assert.equal(await readFile(path, "utf8"), original);
  assert.deepEqual((await readdir(join(dir, "spec/journal/entries"))).filter(name => name.endsWith(".md")), []);
  await writeFile(join(dir, lateName), late + "Changed after archival.\n");
  await assert.rejects(run(dir, ["scripts/release-prepare.mjs", "2.10.0"]), /Archived entry changed/);
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal(await readFile(join(dir, lateName), "utf8"), late + "Changed after archival.\n");
});

test("tagged or npm-published versions and registry outages leave files untouched", async t => {
  for (const mode of ["tag", "npm", "offline"]) {
    const dir = await sandbox(t);
    await writeFile(join(dir, lateName), late);
    if (mode === "tag") execFileSync("git", ["tag", "v2.10.0"], { cwd: dir });
    const before = await readFile(join(dir, "package-lock.json"), "utf8");
    await assert.rejects(prepareRelease(dir, "2.10.0", { published: async () => {
      if (mode === "offline") throw new Error("registry unavailable");
      return true;
    } }), /already released|registry unavailable/);
    assert.equal((await read(dir, "packages/harness/package.json")).version, "2.9.0");
    assert.equal(await readFile(join(dir, "package-lock.json"), "utf8"), before);
    assert.equal(await readFile(join(dir, lateName), "utf8"), late);
    await assert.rejects(readFile(join(dir, "spec/journal/archive/2.10.0.md")), { code: "ENOENT" });
  }
});

test("invalid journal entries fail before bumping the package", async t => {
  const dir = await sandbox(t);
  await writeFile(join(dir, lateName), "invalid entry");
  await assert.rejects(run(dir, ["scripts/release-prepare.mjs", "2.10.0"]), /missing front matter/);
  assert.equal((await read(dir, "packages/harness/package.json")).version, "2.9.0");
});

test("publication check accepts only a registry 404 as unpublished", async () => {
  assert.equal(await isPublished("2.10.0", async () => new Response("", { status: 404 })), false);
  assert.equal(await isPublished("2.10.0", async () => Response.json({ name: "cairn-engine", version: "2.10.0" })), true);
  await assert.rejects(isPublished("2.10.0", async () => new Response("", { status: 503 })), /HTTP 503/);
  await assert.rejects(isPublished("2.10.0", async () => Response.json({ version: "2.9.0" })), /Unexpected/);
});

test("a version already merged into main is blocked before npm finishes publishing", async t => {
  const dir = await sandbox(t, { version: "2.9.3" });
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "main release"], { cwd: dir });
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: dir });
  await assert.rejects(run(dir, ["scripts/release-prepare.mjs", "2.9.3"]), /already on main/);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }), "");
});

test("the CLI exports the original previous version to Actions on both preparation and refresh", async t => {
  const dir = await sandbox(t);
  const output = join(dir, "actions-output");
  const mock = "data:text/javascript," + encodeURIComponent('globalThis.fetch = async () => new Response("", { status: 404 });');
  const cli = () => execFileSync(process.execPath, ["--import", mock, "scripts/release-prepare.mjs", "2.10.0"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output },
  });
  assert.match(cli(), /Prepared 2\.10\.0/);
  assert.match(cli(), /Refreshed 2\.10\.0/);
  assert.equal(await readFile(output, "utf8"), "previous=2.9.0\nprevious=2.9.0\n");
});
