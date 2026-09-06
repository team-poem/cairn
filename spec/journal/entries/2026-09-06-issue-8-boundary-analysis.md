# 2026-09-06 — #8 package-boundary analysis

- Branch: local `develop` at `81493a3`; remote develop observed at `94ee94ebdb2c64d9be1b16c4a22ee4f940538d2d`. No checkout update or implementation change.
- Request: analyze #8 and proceed with solp721's latest direction. The comment places CLI/package restructuring before the runnable example; Discussion #168 leaves separate packages versus enforced internal boundaries undecided.
- Result: `docs/plans/2026-09-06-issue-8-package-boundaries.md` records source evidence, a nonbreaking internal-boundary proposal, staged deliverables, consumer-tarball CI requirements, and candidate acceptance cases.
- Finding: latest CLI reaches six non-exported helpers. A public-only CLI needs deliberate diagnostic/formatting ownership; exporting every helper mechanically would expand the API without a contract.
- Validation: local CLI, CLI-argument and browser-entry tests pass, 3 files / 12 tests. Initial CLI failures were sandbox IPC EPERM; identical tests passed with normal permissions. Remote CLI imports were inspected; remote HEAD was not tested.
- Scope gate: `spec.md` and `failed-test.md` remain placeholders. The human-written goal is required before implementation and probed test planning. No source or existing tests were edited.
- State delta: #8 now has a local proposal; package restructuring and the example remain unimplemented and unapproved as a detailed design. No release, PR, issue comment, or issue closure occurred. `state.md` is unchanged.
- Reflection: installed-package tests must run outside the workspace to establish an actual consumer boundary. Existing source-import tests do not provide that evidence. Root brain and skill files were left unchanged under the harness guard.
- Review: independent read-only review found no material factual errors; added explicit existing export/type compatibility and the harness→qa prohibition to the acceptance conditions.
