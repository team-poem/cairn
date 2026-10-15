import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Read-only guard: a release merge may be on main without being back-merged into develop. */
export function assertReleaseHistory(directory) {
  const git = args => execFileSync("git", args, {
    cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (git(["rev-parse", "--is-shallow-repository"]) !== "false") {
    throw new Error("Release history is shallow. Fetch full main/develop history before preparing a release.");
  }
  let main;
  try { main = git(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]); }
  catch { throw new Error("origin/main is missing. Fetch main and develop before preparing a release."); }
  const head = git(["rev-parse", "HEAD"]);
  const ancestor = (before, after) => {
    const result = spawnSync("git", ["merge-base", "--is-ancestor", before, after], { cwd: directory });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) throw new Error("Cannot verify release ancestry");
    return result.status === 0;
  };
  if (ancestor(main, head)) return;
  const [commit, first, released, ...extra] = git(["rev-list", "--parents", "-n", "1", main]).split(" ");
  // A normal develop -> main release has two parents, and its released develop parent remains
  // in the next develop history. No back-merge is necessary just to copy that merge commit.
  if (commit === main && first && released && !extra.length && ancestor(released, head)) return;
  throw new Error("main history is not connected to develop (possible squash/rebase release or unmerged main-only changes). " +
    "Merge origin/main into develop, resolve and verify the content, then rerun Prepare release. " +
    "Use a merge commit, not squash/rebase, for both the repair and future develop -> main releases.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { assertReleaseHistory(process.cwd()); console.log("Release history is connected."); }
  catch (error) { console.error(`release-history: ${error.message}`); process.exitCode = 1; }
}
