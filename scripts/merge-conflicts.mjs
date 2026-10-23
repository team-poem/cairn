import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const same = (a, b) => a.length === b.length && a.every((line, i) => line === b[i]);
const inOrder = (inner, outer) => {
  let i = 0;
  for (const line of outer) if (line === inner[i]) i++;
  return i === inner.length;
};

/**
 * Resolve a conflicted file written with merge.conflictStyle=diff3, where "ours" is the pull
 * request and "theirs" is develop. A block is resolved only when the pull request brings nothing
 * develop lacks: either side left the base unchanged, or the pull request only added lines and
 * develop already has all of them in the same order. Anything else is a decision for a person, so it returns null.
 */
export function resolveContained(text) {
  const lines = text.split(/(?<=\n)/);
  const out = [];
  let resolved = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("<<<<<<< ")) { out.push(lines[i]); continue; }
    const block = { pr: [], base: [], dev: [] };
    let side = "pr";
    for (i++; i < lines.length && !lines[i].startsWith(">>>>>>> "); i++) {
      if (lines[i].startsWith("||||||| ")) side = "base";
      else if (lines[i] === "=======\n" || lines[i] === "=======") side = "dev";
      else block[side].push(lines[i]);
    }
    if (i === lines.length || side !== "dev") return null;
    const { pr, base, dev } = block;
    if (same(pr, base)) out.push(...dev);
    else if (same(dev, base)) out.push(...pr);
    else if (inOrder(base, pr) && inOrder(pr, dev)) out.push(...dev);
    else return null;
    resolved++;
  }
  return resolved ? out.join("") : null;
}

/**
 * Merge develop into a same-repository pull request branch without force-pushing it.
 * Returns "landed" when the merge result equals develop (nothing left to merge, nothing pushed),
 * "resolved" with the pushed merge commit, "conflict" when a person must resolve it, or
 * "changed" when the branch moved since it was evaluated.
 * Git only treats the branch as data here; no code from the pull request is executed.
 */
export function mergeDevelopInto({ cwd, number, ref, head, token }) {
  const auth = token
    ? ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`]
    : [];
  const git = (args, dir = cwd) => execFileSync("git", args, {
    cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const shallow = git(["rev-parse", "--is-shallow-repository"]) === "true";
  git([...auth, "fetch", "--no-tags", "--quiet", ...(shallow ? ["--unshallow"] : []), "origin",
    "+refs/heads/develop:refs/remotes/origin/develop", `+refs/pull/${number}/head:refs/remotes/pr/${number}`]);
  if (git(["rev-parse", `refs/remotes/pr/${number}`]) !== head) return { kind: "changed" };

  const dir = mkdtempSync(join(tmpdir(), `cairn-pr-${number}-`));
  try {
    git(["worktree", "add", "--quiet", "--detach", dir, head]);
    try {
      git(["-c", "merge.conflictStyle=diff3", "merge", "--no-ff", "--no-commit", "origin/develop"], dir);
    } catch {
      // Conflicts are resolved below; anything the resolver cannot prove safe stays unmerged.
    }
    for (const path of git(["diff", "--name-only", "--diff-filter=U"], dir).split("\n").filter(Boolean)) {
      // Delete/modify and add/add-binary conflicts have no three text stages to compare.
      if (new Set(git(["ls-files", "-u", "--", path], dir).split("\n").map(line => line.split(/\s+/)[2])).size !== 3) {
        return { kind: "conflict" };
      }
      const resolved = resolveContained(readFileSync(join(dir, path), "utf8"));
      if (resolved === null) return { kind: "conflict" };
      writeFileSync(join(dir, path), resolved);
      git(["add", "--", path], dir);
    }
    if (git(["diff", "--name-only", "--diff-filter=U"], dir)) return { kind: "conflict" };
    git(["-c", "user.name=pingu-cairn[bot]", "-c", "user.email=pingu-cairn[bot]@users.noreply.github.com",
      "commit", "--quiet", "--no-verify", "-m", `Merge branch 'develop' into ${ref}`], dir);
    if (!git(["diff", "--name-only", "origin/develop", "HEAD"], dir)) return { kind: "landed" };
    const sha = git(["rev-parse", "HEAD"], dir);
    // A plain push is a fast-forward of the reviewed head; if the branch moved, it is rejected.
    git([...auth, "push", "--quiet", "origin", `HEAD:refs/heads/${ref}`], dir);
    return { kind: "resolved", sha };
  } finally {
    try { git(["worktree", "remove", "--force", dir]); } catch { rmSync(dir, { recursive: true, force: true }); }
  }
}
