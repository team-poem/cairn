# AGENTS.md — the cairn development harness

Rules an AI coding agent follows before changing this repository, and a router telling it which
document to read. Read the smallest document the task needs, never a large one whole.

Everything a contributor reads is English: source, comments, error messages, specs, docs, commit
messages, journal entries. `npm run check:language` enforces it in CI. Conversation with a maintainer
can be in any language; the repository cannot.

## 0. Start of session

1. `spec/journal/state.md` — standing decisions, the release procedure, environment notes. Short and
   slow-moving. Always first.
2. `npm run journal:status` — what is in flight right now, derived from `spec/journal/entries/`.
   Never committed, so it cannot go stale.
3. `spec/architecture.md` (invariants) and `spec/core/` (mechanism specs) when the task touches
   design.

## 1. Routing — task to document

- Core, pipeline, interfaces (`packages/harness/**`) → **`spec/architecture.md` is required.**
- Understanding or changing a core mechanism (the loop, judgment, targeting, self-heal) → `spec/core/`.
- QA app (`packages/qa/**`) → `spec/architecture.md`.
- Product design and context → `docs/design.md`.
- Code-style documents live in `spec/code/` once code accumulates. Do not write them ahead of time.

## 2. Design invariants — do not break

Touching `packages/**` means reading `spec/architecture.md` and holding its invariants: pattern is
not data / extend through interfaces only / the loop belongs to discovery / replay is deterministic /
the dependency direction is qa to harness. `.claude/hooks/route.sh` reminds you automatically.

## 3. Spec reference disclosure

Immediately before writing or changing code, say in one line which spec rule you are applying.

> This is a [kind of change], so I am following the [rule] in [`spec/...`].

A pointer, not a summary. If the rule conflicts with the change, report that at the end.

## 4. Verify before done

Before saying it is finished: typecheck, build and tests pass. Dogfood where you can — run cairn
against itself. Pass whatever review checklist exists in `spec/code/`.

## 5. The journal

`spec/journal/` is the continuity record: why something was decided, and what is in flight.

- **`entries/`** holds the current release cycle, one file per work item, **append-only**. Add a new
  file; never edit an existing one. That is what lets two branches touch the journal without ever
  conflicting, and it is why no branch rule is needed.
- Each entry starts with front matter, then English prose:

  ```
  ---
  issue: 225
  pr: 226
  status: landed
  summary: Both discovery loops send the element listing every turn
  next: null
  ---
  ```

  `status` is `landed`, `in-progress`, `blocked` or `abandoned`. `summary` is one line and is what
  `npm run journal:status` shows. `next` is a single line or `null`. `npm run journal:check`
  validates every entry.
- **`state.md`** holds only what outlives a cycle: standing decisions, the release procedure,
  environment notes. It is not a status board; status is derived.
- **`archive/`** holds one file per release. At release time `npm run journal:archive <version>`
  folds the cycle's entries into it and empties `entries/`.
- **`history.md`** is frozen. Do not append.

An entry is for work that carries a decision. A typo fix does not need one. An outside contributor
is not expected to write one: for those changes the pull request body is the record, and a maintainer
adds an entry if the change carries a decision worth keeping.

## 6. Rules evolve

When a decision repeats or two rules collide, add a line under **Rule candidates** in
`spec/journal/state.md`. If it keeps repeating, promote it to a real rule in `spec/code/`.

## 7. Conventions

- English everywhere in the repository. See the note at the top.
- Commits small and single-purpose.

## 8. Agent contributions — avoiding slop

An agent can produce tidy, worthless change quickly: quietly weakening an invariant, padding a pull
request with unrelated edits, skipping verification. These rules exist to stop that. The full human
contribution process is in `CONTRIBUTING.md`.

- **You are a tool; a person owns the result.** A named person reads, understands and answers for
  every line. Do not submit a change you cannot explain.
- **Disclose AI use.** When an agent wrote a meaningful part of a diff, add an `Assisted-by: <model>`
  trailer to the commit, except for trivial edits. `CONTRIBUTING.md` has the detail.
- **A person does the talking.** An agent does not post issue or pull request comments on someone's
  behalf. Take the draft and rewrite it in your own voice.
- **Hold the invariants** (§2). If one seems to need weakening, agree it in an issue first.
- **Follow §3 and §4.** CI enforces verification: typecheck, build, tests, boundaries, language and
  the journal check. Red means no merge.
- **Small, single-purpose changes.** One logical change per pull request. No drive-by refactors or
  formatting. Anything larger than a bug fix is agreed with a maintainer before code is generated.
- **Do not hand-edit generated or frozen output.** `dist/`, `build/` and `bench/results/` are
  regenerated and are all gitignored.
- **Update the journal when you finish** (§5).
