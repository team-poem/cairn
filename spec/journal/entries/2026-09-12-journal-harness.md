---
issue: null
pr: 234
status: landed
summary: The journal became append-only, English is enforced in CI, and state.md stopped being a status board
next: null
---

# The journal harness

The journal was a good record kept by hand, and both halves of that were failing. `state.md` was 314
lines under a heading telling itself to stay small, carrying a "next steps" section three times over
and a status from three releases ago. `entries/` had 95 files and September alone added 67, so the
directory was growing faster than anyone would ever read it. And 86 of those 95 were Korean, in a
repository that expects outside contributions.

The fix was to stop asking people to keep rules and let the harness keep them instead.

## Append-only entries, so the branch rule is unnecessary

`state.md` was develop-only because every branch editing one file means every pull request conflicts.
That rule solved the conflict by adding friction: the maintainer had to reach past branch protection
each cycle. Entries are now append-only, one file per work item with front matter, never edited after
they land, so two branches cannot collide in the journal at all. The rule was removed rather than
enforced.

Front matter is the contract that makes the directory machine-readable: `issue`, `pr`, `status`,
`summary` and `next`. `npm run journal:status` derives what is in flight from it and prints it
without committing, so the thing that used to go stale cannot. `npm run journal:check` validates
every entry in CI.

## One archive per release

`npm run journal:archive <version>` folds a cycle's entries into `spec/journal/archive/<version>.md`
and empties `entries/`, so the directory holds a cycle and the repository holds the history. It runs
at release preparation, next to the version bump. `history.md` already worked this way and had been
frozen since 2026-07-03 because the fold was manual.

## English, checked rather than agreed

`npm run check:language` fails `verify` on CJK in tracked source, spec or documentation. A file that
must carry non-English text to do its job, the ranking fixtures that prove CJK tokenization for
example, opts out with a marker on its own line, so the exemption travels with its reason instead of
living in a path list.

The 95 existing entries were condensed into English archives for 2.3.0 through 2.9.0 rather than
translated line by line; the originals stay in git history. Three benchmark documents the README
links publicly were translated in full, with every figure, hash and command preserved and verified
by multiset comparison of their numeric tokens.

## What a contributor is now asked for

Nothing. `AGENTS.md` and `CONTRIBUTING.md` both say an outside contribution's record is its pull
request body, and a maintainer adds an entry if the change carries a decision worth keeping. An entry
is for work that decides something, not for every commit.

state change: `state.md` now holds standing decisions, the release procedure and environment notes
only, at 84 lines. The npm publishing failure modes found during the 2.9.0 release are written into
the release procedure: a Classic Automation token is required, `E404` means an expired token and
`EOTP` means the token demands a one-time password.
