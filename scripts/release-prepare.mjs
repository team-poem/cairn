#!/usr/bin/env node
// Prepare or refresh an unpublished release. Git commits, pushes and PRs belong to the workflow.
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { archive, readEntries } from "./journal.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const compare = (a, b) => {
  const left = a.split(".").map(BigInt), right = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
};

export async function isPublished(version, request = fetch) {
  const response = await request(`https://registry.npmjs.org/cairn-engine/${version}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Cannot verify npm publication: HTTP ${response.status}`);
  const pkg = await response.json();
  if (pkg.name !== "cairn-engine" || pkg.version !== version) throw new Error("Unexpected npm publication response");
  return true;
}

export async function assertUnreleased(directory, version, published = isPublished) {
  const git = args => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git(["tag", "--list", `v${version}`]) || await published(version)) {
    throw new Error(`${version} is already released (tag or npm); refusing to modify it`);
  }
  // Merging into main authorizes publication; stop even if npm/tag creation is still running.
  if (git(["branch", "-r", "--list", "origin/main"])) {
    const main = JSON.parse(git(["show", "origin/main:packages/harness/package.json"]));
    if (!SEMVER.test(main.version)) throw new Error("Cannot verify the version on main");
    if (compare(main.version, version) >= 0) throw new Error(`${version} is already on main; refusing to modify it`);
  }
}

export async function prepareRelease(directory, version, { published = isPublished } = {}) {
  if (!SEMVER.test(version ?? "")) throw new Error("Usage: release-prepare.mjs <version>");
  const manifest = join(directory, "packages/harness/package.json");
  const lockPath = join(directory, "package-lock.json");
  const pkg = JSON.parse(await readFile(manifest, "utf8"));
  const current = pkg.version;
  if (!SEMVER.test(current)) throw new Error(`Unsupported current version: ${current}`);
  if (compare(version, current) < 0) throw new Error(`${version} is below the current ${current}; a release only goes forward`);
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  if (lock.packages?.["packages/harness"]?.version !== current) {
    throw new Error(`package-lock.json does not carry packages/harness at ${current}`);
  }
  const git = args => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  // Fail closed on registry or Git failures, before touching any release files. CI fetches all tags.
  await assertUnreleased(directory, version, published);
  const directories = { entries: join(directory, "spec/journal/entries"), archive: join(directory, "spec/journal/archive") };
  const entries = await readEntries(directories.entries);
  const archivePath = join(directories.archive, `${version}.md`);
  let existing = null;
  try { existing = await readFile(archivePath, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const refresh = version === current;
  let previous = current;
  if (refresh) {
    if (!existing?.startsWith(`# ${version}\n`) || !existing.includes(`\n## Release ${version}\n`)) {
      throw new Error(`Version is already ${version}, but no matching prepared archive exists`);
    }
    // Older archives (including prepared 2.9.3) identify the previous version in prose.
    const section = existing.split(`\n## Release ${version}\n`)[1].split("\n---\n")[0];
    previous = /<!-- release-previous: (\d+\.\d+\.\d+) -->/.exec(section)?.[1]
      ?? /^(?:Since|\d+ pull requests? since) (\d+\.\d+\.\d+)/m.exec(section)?.[1];
    if (!previous || compare(previous, version) >= 0) throw new Error("Cannot identify the previous release from the prepared archive");
  } else if (existing !== null) {
    throw new Error(`Archive already exists for ${version}; refusing to overwrite it`);
  }

  if (!refresh) {
    const date = new Date().toISOString().slice(0, 10);
    const name = `${date}-${version}-release.md`;
    if (entries.some(entry => entry.name === name)) throw new Error(`Release entry already exists: ${name}`);
    const since = args => { try { return git(args); } catch { return ""; } };
    const stat = since(["diff", "--shortstat", `v${previous}...HEAD`]);
    // Squash-merged PRs belong in the release record too.
    const prs = [...new Set(since(["log", `v${previous}..HEAD`, "--format=%s"]).split("\n")
      .map(line => (/^Merge pull request #(\d+)/.exec(line) ?? /\(#(\d+)\)$/.exec(line))?.[1]).filter(Boolean))];
    const text = [
      "---", "issue: null", "pr: null", "status: landed", `summary: Release ${version}`, "next: null", "---", "",
      `<!-- release-previous: ${previous} -->`, "",
      prs.length ? `${prs.length} pull request${prs.length === 1 ? "" : "s"} since ${previous}: ${prs.map(n => `#${n}`).join(", ")}.` : `Since ${previous}.`,
      stat ? `\n${stat}.` : "", "", "Replace this paragraph with what the release is about, and say plainly what it does not do.", "",
    ].join("\n");
    await mkdir(directories.entries, { recursive: true });
    await writeFile(join(directories.entries, name), text, { flag: "wx" });
    pkg.version = version;
    lock.packages["packages/harness"].version = version;
    await writeFile(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  }
  const message = await archive(version, await readEntries(directories.entries), { directories, refresh });
  return { previous, refresh, message };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await prepareRelease(root, process.argv[2]);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `previous=${result.previous}\n`);
    console.log(`${result.refresh ? "Refreshed" : "Prepared"} ${process.argv[2]}\n${result.message}`);
  } catch (error) {
    console.error(`release-prepare: ${error.message}`);
    process.exitCode = 1;
  }
}
