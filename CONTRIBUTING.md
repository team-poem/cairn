# Contributing to cairn

Thanks for helping mark the trail. cairn is an engine, not a product, and it is
still early — the six interfaces (`ContextProvider · Planner · Driver · SkillStore ·
Critic · Reporter`) are the contract; the surface around them still moves.
Contributions that respect that contract are the most valuable kind.

## Ways to contribute

- **Open an issue** to report a bug, propose a feature, or ask a question.
- **Open a pull request** to fix a bug, improve docs, or implement something a
  maintainer has already signed off on.
- **Report a security issue privately.** Please don't open a public issue for a
  vulnerability — use GitHub's private reporting (the repo's **Security → Report a
  vulnerability**) so it can be fixed before disclosure.

## Contribution workflow

1. **Start from an issue.** Find an existing one or open a new one. For anything
   larger than a bug fix, describe your approach and wait for a maintainer to confirm
   the direction *before* you write code (see
   [AI / agent contributions](#ai--agent-contributions)).
2. **Branch from `develop`.** Name it for the change: `feat/...`, `fix/...`, `docs/...`.
   `develop` is the integration branch; `main` holds the latest published release.
3. **Make one focused change.** Hold the [design invariants](#design-invariants); keep
   unrelated edits out.
4. **Verify** (see [below](#verify-before-done)) — typecheck, build, test, and dogfood
   when you can.
5. **Commit** following the [commit convention](#commit-convention).
6. **Open a pull request to `develop`**, fill in the template, and **link the issue** it
   resolves. `cairn-bot` validates that every PR links an issue.
7. **Respond to review.** Once approved, a maintainer merges it into `develop` (squash-rebase).

## Releases

`develop` is where work accumulates; `main` holds the latest published release. A maintainer
cuts a release by merging `develop` → `main`, bumping the version, tagging `vX.Y.Z`, and
publishing to npm. **Only maintainers merge to `main`** — that merge _is_ the release.

When a PR is merged into `develop`, `cairn-bot` closes issues referenced with
`Closes #N`, `Fixes #N`, or `Resolves #N`. The later `develop` → `main` release merge
is manual and does not close additional issues.

## Development setup

```sh
npm install
npm run build       # compile all workspaces
npm run typecheck   # type-check without emitting
npm run test        # run the test suites (vitest)
```

The engine lives in `packages/harness` (published as `cairn-engine`); the CLI is a
thin wrapper over the library. Run it from source with `npm run dev` inside that
package.

## Design invariants

cairn stays small by holding a few lines. Don't weaken them inside a feature PR — if
a change seems to require it, open an issue first. Full detail lives in
`spec/architecture.md`.

- **Pattern, not data.** The core knows no specific app or environment; everything
  app-specific arrives through an interface.
- **Extend through interfaces.** Add behavior by implementing one of the six ports,
  not by editing the core.
- **The loop only discovers.** The single LLM loop exists to discover and self-heal
  — replay never calls the LLM.
- **Replay is deterministic.** A frozen scenario replays with no LLM in the loop.
- **Dependencies point inward.** Adapters depend on core, never the reverse; `qa`
  depends on `harness`, never the other way.

## Commit convention

cairn uses [Conventional Commits](https://www.conventionalcommits.org). Write the
subject in **English**, imperative mood, lowercase, with no trailing period:

```
type(scope): subject
```

- **type** — `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, or `bench`.
- **scope** (optional) — the area touched, e.g. `engine`, `driver`, `critic`,
  `planner`, `qa`.
- Keep the subject under ~72 characters; put detail in the body.
- Add an `Assisted-by:` trailer when an agent wrote a meaningful part of the diff
  (see [AI / agent contributions](#ai--agent-contributions)).

```
feat(driver): add multi-locator freeze for resilient replay

Assisted-by: Claude Opus 4.6
```

Keep commits small and meaningful — one logical step each.

## Pull requests

- **Title** — use the same `type(scope): subject` format as commits, in English.
- **Body** — fill in the PR template (it loads automatically): what changed, why, and
  how you verified it.
- **Link the issue — required.** Reference the issue the PR addresses with
  `Closes #N` (or `Refs #N` if it doesn't fully close it). A PR with no linked issue
  gets sent back.
- **One logical change per PR.** Keep it small and focused — it reviews faster and
  reverts cleanly. No drive-by refactors or formatting-only churn in untouched files.
- **Code, identifiers, comments, and error messages are in English.** Conversation
  can be in any language; the code is English.

## Verify before "done"

Before you request review:

- `npm run typecheck`, `npm run build`, and `npm run test` pass.
- When you can, **dogfood** — run cairn against a real flow once to confirm the loop
  still holds.
- Don't commit generated or frozen outputs: `dist/`, `build/`, and `bench/frozen/`
  are gitignored on purpose.

## AI / agent contributions

cairn welcomes AI-assisted contributions. A few rules keep them additive instead of
noise:

1. **Declare substantial AI assistance.** When an agent wrote a meaningful part of
   the diff, add an `Assisted-by:` trailer at the bottom of the commit message —
   e.g. `Assisted-by: Claude Opus 4.6`. Trivial edits (a typo, a one-line rename)
   don't need one.
2. **Keep conversations human.** Don't let an agent post issue comments, review
   replies, or triage messages on your behalf. If an agent drafted a message,
   rewrite it in your own voice before sending — maintainers need to know they're
   talking to a person, not a bot.
3. **Align before generating large changes.** An agent can produce thousands of
   lines in minutes; review capacity can't scale the same way. For anything beyond a
   bug fix, open an issue and get a maintainer's sign-off before generating the
   implementation.

Agents working *inside* this repo should also read `AGENTS.md` — its anti-slop section
gives repo-specific guidelines for agent contributors.

## Where things live

- `README.md` — the loop, the interfaces, the quickstart.
- `AGENTS.md` — rules and doc-routing for AI coding agents editing this repo
  (`CLAUDE.md` points here).
- `spec/architecture.md` — the invariants above, in full.
- `spec/state.md` — the living state and next steps.
- `docs/design.md` — the product design in full.
