# 2026-09-06 — issue 8 boundary and quickstart integration

- Branch: `codex/8-package-boundaries`, based on develop `94ee94e`.
- Authorization: the user approved proceeding after the concrete internal-boundary proposal and
  acceptance matrix were presented. The human-owned `spec.md` was not overwritten. The local,
  excluded `failed-test.md` records nine checked boundary cases.
- Integrated changes: six additive Node diagnostic exports; CLI imports through the public entry;
  TypeScript dependency guard; independent browser quickstart and tarball-consumer CI matrix.
  The engine remains one published package. Public entry names and installed CLI behavior remain.
- Commits before this record: `2493c46` public diagnostics, `6d01c06` CLI import refactor,
  `2eec473` boundary guard and tests, `21b6ec7` quickstart and consumer CI.
- Parallel work used a separate `apps/cairn-quickstart` worktree. Integration required one manifest
  conflict resolution, preserving both `check:boundaries` and `test:consumer` scripts.

## Review and corrections

- Removed an unnecessary core-to-version allowance: `version.ts` imports `node:module`, and no
  existing core dependency required that exception.
- Reproduced a package-alias bypass through emitted declarations. A CLI `#internal` alias resolving
  to `dist/run.d.ts` and an engine `#cli` alias resolving to `dist/cli.d.ts` were incorrectly treated
  as external. The added regression was probed RED, then passed after classifying resolved package
  files by ownership and normalizing declaration extensions. A second reviewer reran the real
  TypeScript resolver reproduction and verified both rejections and public-entry allowance.
- Consumer CI derives the installed CLI version from the current manifest, parses only pack stdout,
  and checks non-vacuous POST proof. Ordinary failed replay verdicts exit 1; setup/input/invariant
  failures exit 2.
- Existing source tests and fixtures were preserved; the only test-tree change from the base is the
  added dependency-boundaries test file.

## Verified on the integrated branch

- Clean `npm ci --ignore-scripts`, app typecheck and build, and the dependency guard passed.
- Full suite: 42 files / 924 tests passed on Node 26.5.1 and on Node 20.19.5.
- Sobaya gate against `94ee94e`: PASS on Node 20.19.5. Because this imported app excludes
  `failed-test.md`, the gate reports zero newly tracked plan entries; the nine checked local names
  were separately matched to actual added test declarations.
- npm 12.0.2 / Node 26.5.1: `npm run test:consumer -- npm` passed against the integrated tarball.
- npm 10.8.2 / pnpm 10.34.5 / Node 20.19.5: `npm run test:consumer -- pnpm` passed against the
  integrated tarball. Node 20 came from an official distribution with its SHA-256 verified, used
  only through a temporary PATH; system runtime settings were not changed.
- Both consumer runs installed outside the repository, typechecked public imports, exercised the
  installed CLI, built the browser entry without Node externals, and drove actual Chrome through
  discovery, freeze/load, two LLM-free replays, and a POST-500 failure despite reaching `/success`.
  Missing/malformed input and fixture-port cleanup also passed.
- TypeScript public-surface comparison against the base preserved all 127 existing Node export
  names and resolved value signatures, adding six. All 95 browser exports were preserved, adding
  none. Source type declarations were unchanged.
- GitHub Actions is configured; no remote workflow run is claimed. Actual model discovery is
  documented but was not invoked; browser CI uses four explicit scripted completions.

## State delta and reflection

- Issue 8 now has the internal boundary enforcement and runnable consumer proof requested by its
  latest comment. No npm release or issue closure was performed. `state.md` remains unchanged on
  the feature branch; the integration can be reflected there after merge.
- Durable lesson: dependency ownership follows resolved package files, including build declarations,
  rather than only source-directory paths. An isolated tarball consumer catches errors that source
  imports and workspace links can hide.
- Reflection routing: structural enforcement and app documentation were updated. Root brain, skills,
  and todos were not changed under the harness guard. The user's pre-existing `reports/` was kept.
