# state — what outlives a release cycle

> Standing decisions, the release procedure, environment notes. Short and slow-moving.
>
> **This is not a status board.** What is in flight comes from `npm run journal:status`, derived from
> `spec/journal/entries/`. Nothing here is regenerated, so nothing here should need updating weekly.
> Per-cycle history lives in `spec/journal/archive/<version>.md`.

## Standing decisions

- Architecture invariants live in `spec/architecture.md`.
- **Ports and adapters.** `src/core/` holds the domain and the ports (types, ports, pipeline,
  discover, steps); `src/adapters/` holds implementations; `run.ts` is the composition root. The
  dependency direction is adapters to core. The public API is the `src/index.ts` barrel.
- **Execute and judge dispatch through ports.** Kind-specific branching routes through `StepHandler`
  and `AssertionHandler` (`supports()` then `execute()`/`judge()`). The built-in `switch` is
  encapsulated in `BuiltinStepHandler`, which keeps the exhaustiveness check. A new action or
  assertion is a registered handler, not a change to core. Default handlers live in
  `core/steps.ts`, depending only on the Driver port and Step types.
- **A frozen skill file is a bare `Scenario`.** No `{ name, scenario }` wrapper and no duplicated
  name. `SkillStore.resolve(name)` and `loadSkillFile(path)` both return a `Scenario`, and saving
  goes through `saveSkillFile(path, scenario)` rather than a raw `writeFileSync`.
- The default driver is Chrome DevTools MCP.
- The shape is an embeddable engine plus a thin CLI. The desktop app is a separate project that
  installs the engine. Environment-specific behaviour arrives through `ContextProvider` and
  `Reporter` connectors.

## Rule candidates — promote when they repeat

- A driver observation the core depends on (an in-flight status of 0, for example) must exist in the
  reference driver's parser fixtures **in the driver's real output format**. Green through an
  injected `FakeDriver` alone leaves the contract unverified. Proven by #97.
- **Trait or fact.** When promoting an application's pain into the engine, decide whether the
  knowledge is a universal fact or a trait of that application. A trait must not become a universal
  heuristic; it arrives through a seam and injection, as `benign` and `ActionPolicy` did. Learned
  from #56's locale stripping causing the #86 and #87 regressions.
- Changing a heuristic zone (URL matching, dynamic segment cutting) requires a table-driven
  counterexample corpus. One fix plus one test does not break the chain in that territory.
- **A stacked pull request runs CI zero times.** `verify` triggers only on pull requests targeting
  main or develop, so one based on a feature branch never typechecks, builds or tests. Retargeting
  after the parent merges does not trigger it either, since that is an `edited` event. Merge the
  base, retarget, **confirm verify is green**, then merge.
- **A stacked merge needs a look, not a second click.** After the parent merges and its branch is
  deleted, confirm the child's base switched to develop and its diff carries only its own commits
  before merging. Happened twice: #107 with #109, and #162.
- **Make a review claim reproducible.** Function name, input, output, file and line. "I counted N"
  cannot be checked by the person reading it. When reproduction is expensive, as with a real Chrome
  measurement, hand over the whole fixture.
- **Judge a heal by its goal assertions.** Guards (`no-failed-requests`, `no-console-errors`) describe
  application health, not the path. Whether to re-discover, and whether to hand the result back, both
  go through `goalFailures`; judging on the whole verdict discards a correct repair over a transient
  500. From #189.
- **Split a loop-generated pull request into logical units before review.** A hundred commits and
  nine thousand lines carrying loop artifacts cannot be reviewed. Behaviour fixes go separately;
  coverage goes into the existing per-module test files. From #193.

## Release procedure

1. On develop: bump `packages/harness/package.json` and `package-lock.json`, add a release entry,
   run `npm run journal:archive <version>` to fold the cycle's entries, and update this file if a
   standing decision changed.
2. Open the release pull request from develop to main. Merging it triggers `release.yml`, which
   publishes to npm, pushes the tag and drafts the GitHub release.
3. The npm token is the usual failure. A **Classic Automation** token is required: it bypasses two
   factor authentication, which a granular or publish token does not. An expired token fails with
   `E404` on the PUT, because npm reports missing permission as not found; a token that requires a
   one-time password fails with `EOTP`. Both are fixed by replacing the `NPM_TOKEN` repository secret
   and re-running the failed job.
4. **Two-channel rule, if the beta channel reopens.** `latest` is the stable line and `beta` is the
   experimental one. A prerelease must publish with `npm publish --tag beta`; without the tag npm
   moves `latest` onto the prerelease, since the `-beta.N` suffix only constrains `^` ranges and says
   nothing about the tag. A stable patch branches from main as a hotfix so it never passes through
   the experimental line. Merging develop into main is the decision to make a line official.

## Environment

- The bundled driver spawns its own browser with `npx -y chrome-devtools-mcp@<pinned> --isolated`,
  so it does not collide with an editor session's MCP profile. Node 20 or later and an installed
  Chrome are required.
- Build with `npm run build -w cairn-engine`; the CLI is `node packages/harness/dist/cli.js`.
- With no key set, the local `claude` CLI is the default backend; `ANTHROPIC_API_KEY` selects the
  HTTP API. `--model` picks the model.
- `bench/results/` and `dist/` are generated and gitignored. Benchmark schedules that produced a
  published number are committed beside the bench so a measurement can be repeated.
