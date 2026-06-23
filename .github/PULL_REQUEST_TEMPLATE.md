<!--
Title: use Conventional Commits — type(scope): subject (English).
See CONTRIBUTING.md for the full guide.
-->

## What

<!-- What does this change do? One or two sentences. -->

## Why

<!-- The problem or motivation behind the change. -->

## Related issue

<!-- Required. Use "Closes #N" to auto-close, or "Refs #N" if it doesn't fully close. -->

Closes #

## How it was verified

- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] `npm run test` passes
- [ ] Dogfooded (ran cairn on a real flow), or N/A

## Checklist

- [ ] One logical change — no drive-by refactors or unrelated formatting
- [ ] Design invariants held (see `spec/architecture.md`)
- [ ] `Assisted-by:` trailer added if an agent wrote a meaningful part of the diff
