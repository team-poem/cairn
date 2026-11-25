---
name: merge-develop
description: Merge develop into a cairn pull request branch that conflicts with it. Resolves the conflicts cairn-pingu leaves to the author, renumbers the trace version, verifies, and commits a merge commit without rewriting the branch. Use when a PR shows "This branch has conflicts", when a reviewer asks to resolve the develop conflicts, or after another PR lands on develop first.
user-invocable: true
---

# Merge develop into a PR branch

Usage: `/merge-develop <branch>`. `<branch>` is a same-repository PR branch based on `develop`.

## Rules

- Merge `origin/develop` into the branch with a merge commit. Never rebase or force-push a PR branch.
- cairn-pingu already resolves a conflict where the PR's side is already on develop. This skill handles the rest.
- Ask the author when no rule below covers a conflict, or when you doubt the result. Show both sides and the resolution you propose. Do not guess.
- Do not commit while a failure caused by the merge remains.
- Push and PR comments are the author's call. Stop after the commit and report.

## 1. Pre-flight

1. The working tree is clean: `git status --porcelain` prints nothing.
2. `git fetch origin`, then the local branch matches `origin/<branch>`. Stop when it does not.
3. There is something to merge: `git log --oneline <branch>..origin/develop` is not empty.

## 2. Merge

```sh
git -c merge.conflictStyle=diff3 merge --no-ff --no-commit origin/develop
```

No conflict: go to step 4. Then run cairn-pingu's resolver on each conflicted file. It resolves a file only when every block in it is contained in develop, and leaves the file untouched otherwise:

```sh
for f in $(git diff --name-only --diff-filter=U); do node --input-type=module -e "
import { resolveContained } from '$PWD/scripts/merge-conflicts.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const out = resolveContained(readFileSync(process.argv[1], 'utf8'));
if (out === null) { console.log('needs a person:', process.argv[1]); process.exit(1); }
writeFileSync(process.argv[1], out); console.log('resolved:', process.argv[1]);
" "$f" && git add "$f"; done
```

## 3. Resolve the rest

Before you edit a file, read what each side changed since the merge base:

```sh
MB=$(git merge-base HEAD origin/develop)
git diff $MB HEAD -- <file>
git diff $MB origin/develop -- <file>
```

| Conflict | Rule |
|---|---|
| Trace version (`TRACE_VERSION` and its history comment in `packages/harness/src/core/trace.ts`, the versioning section of `spec/core/trace.md`) | Develop keeps every version it shipped. The PR's additions move to the next free version. In `spec/core/trace.md` the newest version paragraph goes first. |
| Union types (`TruncationReason`, trace gate unions) | Keep both sides' members. |
| Imports and exports (`src/index.ts`, `src/browser.ts`, import lines) | Keep both sides. |
| One side wraps a call, the other changes its arguments | Keep the wrapper and apply the argument change inside it. |
| `spec/journal/entries/` | Never conflicts: entries are append-only, one file each. If it does, ask. |

### After a trace version move

Clean hunks also name the current version. Search the working tree, not the index, for the old number and update each current-version mention: the `Header version` line and the example header in `spec/core/trace.md`, and the header test in `packages/harness/test/run.test.ts`. History entries keep their number.

```sh
grep -rn '<old version>' packages/harness/src packages/harness/test spec
```

### Semantic conflicts

The merge is clean but a test fails, or the two sides compose wrongly. Check where each side's new data passes through the other side's new code, and say in the report whether the result is correct.

## 4. Verify

1. No conflict marker: `grep -rnE '^(<<<<<<<|>>>>>>>) ' packages spec docs scripts` prints nothing.
2. `npm run typecheck`, `npm run build` and `npm run test` pass.
3. `npm run journal:check`, `npm run check:language` and `npm run check:boundaries` pass.
4. The PR's own end-to-end scripts pass, such as `npm run test:discovery-selection` for a selection change. Find them in the PR body's verification list.

A failing test in code neither side changed is pre-existing until proven otherwise. Confirm it on a clean worktree of `origin/develop` (`git worktree add --detach`), report it, and do not fix it here.

## 5. Commit

```sh
git add -A
git commit
```

Subject: `Merge develop into <branch>`. Body: one or two sentences on how the trace version and each hand-resolved conflict were settled. Copy the trailer from the branch's previous merge commit, usually `Assisted-by: <model>`. `git log -1 --format='%p'` shows the PR head first, then `origin/develop`.

## 6. Report

Merge commit, one line per hand-resolved conflict (the file, then what was done), the semantic check result, the commands run and their results. Push only when the author asks.
