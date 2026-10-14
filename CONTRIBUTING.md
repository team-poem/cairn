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
2. **Branch from `develop`.** Name it with one of the working prefixes — `feat/`, `fix/`,
   `docs/`, `chore/`, or `codex/` — the exact allowlist the branch-convention guard enforces.
   A PR opened from any other prefix is **auto-closed** by `cairn-bot` with rename
   instructions (`git branch -m <old> feat/<old>`), so pick the prefix first.
   `develop` is the integration branch; `main` holds the latest published release.
3. **Make one focused change.** Hold the [design invariants](#design-invariants); keep
   unrelated edits out.
4. **Verify** (see [below](#verify-before-done)) — typecheck, build, test, and dogfood
   when you can.
5. **Commit** following the [commit convention](#commit-convention).
6. **Open a pull request to `develop`**, fill in the template, and **link the issue** it
   resolves. `cairn-bot` validates that every PR links an issue.
7. **Respond to review.** Once approved, a maintainer removes `status/1-needs-review` and
   adds `needs-merge` to request a squash merge into `develop` by `cairn-pingu`.
   This transition is manual: approval does not replace the review label, and leaving both
   labels present blocks merging. The required `merge-label-policy` check enforces this for
   manual merges too: it fails if either blocking label is present or `needs-merge` is absent.
   The bot waits for approval and the
   latest CI workflow to pass. The squashed commit credits the PR author; the bot is
   recorded as the merger. After a successful merge the bot removes `needs-merge`.
   Remove `needs-merge` before merging to cancel the request.
   Add `no-merge` to block the bot even when `needs-merge` is present. Removing `no-merge`
   resumes an existing request, so remove `needs-merge` too if you want to cancel it.

## Releases

`develop` is where work accumulates; `main` holds the latest published release. A maintainer
cuts a release by bumping `packages/harness/package.json`'s version on `develop`, then merging
`develop` → `main`. **Only maintainers merge to `main`** — that merge _is_ the release.

Once the merge lands, `.github/workflows/release.yml` takes over: it publishes the new
version to npm, tags the merge commit `vX.Y.Z`, and opens a draft GitHub release with
generated notes for the maintainer to edit and publish. The workflow is idempotent — if
the version in `package.json` is already on npm, it does nothing, so an unrelated push to
`main` (or a re-run) is a no-op.

When a PR is merged into `develop`, `cairn-bot` closes issues referenced with
`Closes #N`, `Fixes #N`, or `Resolves #N`. The later `develop` → `main` release merge
is manual and does not close additional issues.

These are repository Actions secrets a maintainer configures once — contributors never
need them:

- `CAIRN_BOT_CLIENT_ID` and `CAIRN_BOT_PRIVATE_KEY` — the `cairn-bot` GitHub App's client
  ID (not the numeric app ID) and a private key generated from the App settings. Used by
  PR triage, label-driven squash merging, and the trusted OCI CI relay, not the release
  workflow. Merging uses the App's existing Contents write and Pull requests write
  permissions. Merge-eligibility CI reads use the workflow's read-only `GITHUB_TOKEN`.
  The OCI relay separately requests a token
  restricted to `team-poem/oci-ci`, with Contents write for dispatch and Actions read
  for polling. See [OCI verification](docs/oci-ci.md).
- `NPM_TOKEN` — unrelated to `cairn-bot`. An npm granular access token with publish rights
  on `cairn-engine` (bypass-2FA "Automation"-style token, since `release.yml` publishes
  unattended). Only whoever owns the npm package registers this.

The `needs-merge`, `no-merge`, and `status/1-needs-review` labels are case-sensitive.
Create the merge labels once in repository settings; PR triage creates the review label.
`no-merge` and `status/1-needs-review` take precedence over `needs-merge` and are checked
again immediately before the merge API call. The separate `merge-label-policy` job enforces
the same label conditions for manual merges through a develop-only required-check ruleset.
Label changes trigger a fresh check; wait for it to finish before merging. Actions are
asynchronous, so a label change is not an atomic lock on the merge API. The workflow uses
read-only permissions, including on forks, and never changes labels. Check status is shared
by commits, so every open develop PR using the same head must have eligible labels.
If another PR sharing that head closes, changes base, or moves to a different head,
rerun the remaining PR's **Merge label policy** job to refresh a previously blocked result.
The merge workflow uses the existing App secrets and
does not require GitHub's native auto-merge
setting. Its CI completion and five-minute retry triggers become active when the
workflow reaches the default branch (`main`); label and same-repository review events
can run once it reaches `develop`. Scheduled runs may be delayed by GitHub. Drafts,
conflicts, missing approvals, and failed or pending CI leave the PR open. Release PRs
to `main` remain manual. The Actions run's **Merge decisions** summary explains whether
the bot merged a PR or is waiting for a label, approval, CI, or GitHub merge requirements.
A successful workflow run means the evaluation completed, not necessarily that a PR merged.
cairn-pingu also keeps one short English comment on blocked develop PRs with an active
`needs-merge` request. Review or `no-merge` labels alone do not create or update a comment.
While `needs-merge` is present, the comment explains the current label, approval, CI, or
merge-requirement blocker. A changed reason updates that comment; unchanged scheduled
evaluations do not post again. Removing `needs-merge` stops pending notices, including
ones queued before the request was removed. After merging, an
existing notice becomes `Merged.`; closing without merging also resolves it. The bot
rechecks the PR before publishing a queued reason. Comment failures are logged without
changing merge eligibility, and the bot only updates its own marked comment.
If label cleanup fails after a merge, the run reports the failure. The PR's closed event
also attempts cleanup; rerun that event job if cleanup still fails. The bot checks that
the PR is merged without merging it again. Periodic scans only consider open PRs.

The repository-specific required-check configuration is recorded in
`.github/rulesets/merge-label-policy.json`. It requires `merge-label-policy` from the
GitHub Actions App (15368) on `develop` only. It adds no human bypass and preserves the
existing cairn-pingu App bypass (4138904) for journal and release-preparation pushes.
The bot still applies its own label, approval and full-CI checks before merging.
The existing approval and `verify` ruleset is unchanged; release branches and `main`
are outside this label rule.

For initial setup, first open the workflow PR and confirm its `merge-label-policy` job
actually fails for the current review labels. Then create the rule with an administrator
credential using `gh api --method POST repos/team-poem/cairn/rulesets --input
.github/rulesets/merge-label-policy.json`. If the named rule already exists, update its ID
with PUT instead of creating a duplicate. The JSON file alone does not configure GitHub.
This read-only PR workflow runs on the setup PR, so it does not require a main release
or a temporary human bypass to bootstrap. As with other PR CI, workflow and policy changes
are reviewed as part of the PR; this is a guard against accidental merges, not protection
against a maintainer deliberately changing the enforcement code or repository settings.

## Development setup

```sh
npm install
npm run build       # compile all workspaces
npm run typecheck   # type-check without emitting
npm run test        # run the test suites (vitest)
```

One suite is kept out of `npm run test`: `packages/harness/test/browser` drives a headless Chrome
because the in-page probe reads element boxes and hit tests, which jsdom cannot answer. Run it with
`npm run test:browser -w cairn-engine` — it uses the Chrome you already have installed, and CI runs
it as its own job.

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
- If you touched the in-page probe (`packages/harness/src/adapters/drivers/chrome.ts`), also
  `npm run test:browser -w cairn-engine` — and add the layout you were fixing to
  `test/fixtures/probe/` so the next person inherits the case rather than the bug.
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

## Everything here is English

Source, comments, error messages, specs, docs and journal entries are English. `npm run
check:language` runs in CI and fails on anything else in a tracked file. Commit messages and pull
request bodies are English too, by convention rather than by check.

Exempt: `spec/journal/archive/` and `spec/journal/history.md`, since a record rewritten after the
fact is a worse record, and `docs/design.md`, which is still Korean and is on the list to translate.
A test or fixture that must carry non-English text opts out with a marker on its own comment line.

## Where things live

- `README.md` — the loop, the interfaces, the quickstart.
- `AGENTS.md` — rules and doc-routing for AI coding agents editing this repo
  (`CLAUDE.md` points here).
- `spec/architecture.md` — the invariants above, in full.
- `spec/journal/state.md` — standing decisions, the release procedure, environment notes.
- `spec/journal/entries/` — one file per work item in the current cycle, append-only. Folded into
  `spec/journal/archive/<version>.md` at each release. `npm run journal:status` shows what is in
  flight. You are not expected to add an entry. When your pull request merges, a bot drafts one on
  develop from the pull request itself, and a maintainer edits it if the change carries a decision
  worth keeping.
- `docs/design.md` — the product design in full.
