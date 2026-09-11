import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  return dir;
}
const run = (dir, args) => execFileSync(process.execPath, args, { cwd: dir, encoding: "utf8" });
const fails = (dir, args) => {
  try { run(dir, args); return null; }
  catch (error) { return `${error.stdout ?? ""}${error.stderr ?? ""}`.trim(); }
};
const read = async (dir, path) => JSON.parse(await readFile(join(dir, path), "utf8"));

test("releasePrepareBumpsOnlyTheHarnessEntries", async (t) => {
  const dir = await sandbox(t);
  run(dir, ["scripts/release-prepare.mjs", "2.10.0"]);
  assert.equal((await read(dir, "packages/harness/package.json")).version, "2.10.0");
  const lock = await read(dir, "package-lock.json");
  assert.equal(lock.packages["packages/harness"].version, "2.10.0");
  // The dependency that shared the version must not move, or its integrity hash becomes a lie.
  assert.equal(lock.packages["node_modules/tinybench"].version, "2.9.0");
  assert.match(lock.packages["node_modules/tinybench"].resolved, /tinybench-2\.9\.0\.tgz/);
});

test("releasePrepareRefusesToGoBackwardsOrNowhere", async (t) => {
  const dir = await sandbox(t);
  assert.match(fails(dir, ["scripts/release-prepare.mjs", "2.9.0"]) ?? "", /already 2\.9\.0/);
  assert.match(fails(dir, ["scripts/release-prepare.mjs", "2.8.0"]) ?? "", /below the current 2\.9\.0/);
  assert.match(fails(dir, ["scripts/release-prepare.mjs", "2.8.9"]) ?? "", /below the current/);
  assert.match(fails(dir, ["scripts/release-prepare.mjs", "latest"]) ?? "", /Usage/);
  // A refusal must leave the manifest alone, so a retry starts from a clean state.
  assert.equal((await read(dir, "packages/harness/package.json")).version, "2.9.0");
});

test("releasePrepareRefusesALockfileThatDoesNotCarryTheCurrentVersion", async (t) => {
  const dir = await sandbox(t, { lock: { packages: { "": {}, "packages/harness": { version: "2.7.0" } } } });
  assert.match(fails(dir, ["scripts/release-prepare.mjs", "2.10.0"]) ?? "", /does not carry packages\/harness at 2\.9\.0/);
});

test("releasePrepareFoldsItsOwnEntryIntoTheArchiveItDescribes", async (t) => {
  const dir = await sandbox(t);
  await writeFile(join(dir, "spec/journal/entries/2026-01-01-earlier.md"),
    "---\nissue: 7\nstatus: landed\nsummary: An earlier thing\nnext: null\n---\n\n# An earlier thing\n\nBody.\n");
  run(dir, ["scripts/release-prepare.mjs", "2.10.0"]);
  const archived = await readFile(join(dir, "spec/journal/archive/2.10.0.md"), "utf8");
  // The order matters: written before the fold, or the release's own record lands next cycle.
  assert.match(archived, /## Release 2\.10\.0/);
  assert.match(archived, /## An earlier thing/);
  assert.deepEqual((await readdir(join(dir, "spec/journal/entries"))).filter((n) => n.endsWith(".md")), []);
});

test("releasePrepareCreatesTheEntriesDirectoryWhenAFoldRemovedIt", async (t) => {
  const dir = await sandbox(t);
  await rm(join(dir, "spec/journal/entries"), { recursive: true, force: true });
  run(dir, ["scripts/release-prepare.mjs", "2.10.0"]);
  assert.match(await readFile(join(dir, "spec/journal/archive/2.10.0.md"), "utf8"), /## Release 2\.10\.0/);
});
