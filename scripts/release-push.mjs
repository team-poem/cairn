import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertUnreleased, isPublished } from "./release-prepare.mjs";

export async function pushPreparedRelease(directory, version, { published = isPublished } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("A release version is required");
  const git = args => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const base = git(["rev-parse", "HEAD"]);
  git(["fetch", "origin", "--tags"]);
  if (git(["rev-parse", "origin/develop"]) !== base) {
    throw new Error("develop changed during preparation. Wait for Journal entry, then rerun Prepare release; no changes were pushed.");
  }
  await assertUnreleased(directory, version, published);
  git(["add", "--", "packages/harness/package.json", "package-lock.json", "spec/journal"]);
  const diff = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: directory });
  if (diff.error) throw diff.error;
  if (diff.status === 0) return "No release file changes; no commit or push needed.";
  if (diff.status !== 1) throw new Error("Cannot inspect staged release changes");
  git(["commit", "-m", `chore(release): ${version}`, "-m", "Prepare the version and fold new journal entries into its archive."]);
  // Never force or rebase generated archives. A racing merge/journal push must fail visibly.
  git(["push", "origin", "HEAD:develop"]);
  return `Pushed release preparation for ${version}.`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(await pushPreparedRelease(process.cwd(), process.argv[2])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
