#!/usr/bin/env node
/**
 * Prepare a release on develop: bump the version, write the release entry, fold the cycle's journal
 * entries into one archive file.
 *
 * The three steps were a written procedure, and a written procedure is only as reliable as whoever
 * remembers it. Running them together also makes the order enforceable: the archive must happen
 * after the release entry is written, or the release's own record lands in the next cycle.
 *
 * This changes files only. Committing, pushing and opening the release pull request belong to the
 * workflow, so the same command can be run locally to inspect the result before anything moves.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SEMVER = /^\d+\.\d+\.\d+$/;

const rank = (v) => v.split(".").map(Number).reduce((n, part) => n * 100000 + part, 0);

/**
 * Edit the two entries that name the harness and nothing else. A string replacement over the
 * lockfile would also rewrite any dependency that happens to share the version, leaving its
 * `resolved` URL and `integrity` hash pointing at the old one, and `npm ci` does not complain.
 */
async function bump(version) {
  const manifest = join(root, "packages/harness/package.json");
  const lockPath = join(root, "package-lock.json");
  const pkg = JSON.parse(await readFile(manifest, "utf8"));
  const current = pkg.version;
  if (current === version) throw new Error(`packages/harness/package.json is already ${version}`);
  if (rank(version) < rank(current)) throw new Error(`${version} is below the current ${current}; a release only goes forward`);
  pkg.version = version;
  await writeFile(manifest, `${JSON.stringify(pkg, null, 2)}\n`);

  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const entry = lock.packages?.["packages/harness"];
  if (entry?.version !== current) throw new Error(`package-lock.json does not carry packages/harness at ${current}`);
  entry.version = version;
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return current;
}

/** The release's own entry is written before the fold, so it lands in the archive it describes. */
async function releaseEntry(version, previous) {
  const date = new Date().toISOString().slice(0, 10);
  const dir = join(root, "spec/journal/entries");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${date}-${version}-release.md`);
  // A shallow checkout has no previous tag, and a first release has no previous tag at all; the
  // entry is still worth writing, so a missing range degrades to no counts rather than failing.
  const since = (args, fallback = "") => {
    try { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
    catch { return fallback; }
  };
  const merges = since(["log", `v${previous}..HEAD`, "--merges", "--format=%s"])
    .split("\n").map((line) => /Merge pull request #(\d+)/.exec(line)?.[1]).filter(Boolean);
  const stat = since(["diff", "--shortstat", `v${previous}...HEAD`]);
  const body = [
    "---", "issue: null", "pr: null", "status: landed",
    `summary: Release ${version}`, "next: null", "---", "",
    merges.length
      ? `${merges.length} pull request${merges.length === 1 ? "" : "s"} since ${previous}: ${merges.map((n) => `#${n}`).join(", ")}.`
      : `Since ${previous}. The merge range was unavailable, so the pull requests are not listed here.`,
    stat ? `\n${stat}.` : "",
    "", "Replace this paragraph with what the release is about, and say plainly what it does not do.", "",
  ].join("\n");
  await writeFile(path, body, { flag: "wx" });
  return path;
}

const [version] = process.argv.slice(2);
try {
  if (!SEMVER.test(version ?? "")) throw new Error("Usage: release-prepare.mjs <version>");
  const previous = await bump(version);
  const entry = await releaseEntry(version, previous);
  // The fold comes last so the release's own entry is inside the archive it describes.
  const folded = execFileSync(process.execPath, [join(root, "scripts/journal.mjs"), "archive", version], { cwd: root, encoding: "utf8" }).trim();
  console.log(`Bumped ${previous} to ${version}\nWrote ${entry}\n${folded}`);
} catch (error) {
  console.error(`release-prepare: ${error.message}`);
  process.exit(1);
}
