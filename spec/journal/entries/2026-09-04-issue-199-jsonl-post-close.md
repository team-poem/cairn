# Issue #199 — JsonlTraceSink post-close race

Branch: `fix/199-jsonl-post-close` off `develop`.

## Problem

`packages/harness/test/adapters/sinks/jsonl.test.ts` — "leaves every already-written attachment
readable when a run is cut short" — flaked intermittently under full-suite parallel load:
`expected [ '1.png', '2.png' ] to deeply equal [ '1.png' ]`.

The issue's own diagnosis (a parallel test writing into the same sidecar directory; fix by
isolating the temp dir per case) was wrong. Each `describe`/`it` in the file already uses its own
subdirectory (`inDir("truncated")` etc.), so no test writes into another's directory.

## Real cause

`JsonlTraceSink#close()` (`packages/harness/src/adapters/sinks/jsonl.ts`) awaited `#queue` only as
it stood at the moment `close()` was called. `emit()` and `attach()` both call `#schedule()`, which
chains a fresh `#flush()` onto `#queue` — but nothing ever awaited a chain added *after* `close()`
started awaiting. The old test called `shot(0); await sink.close(); shot(1);` to simulate "the run
died here" — but `shot(1)` after `close()` scheduled a real, unawaited write. Whether those bytes
landed before the test's `readdir()` resolved was a pure race between two unawaited promise chains,
which only surfaced under full-suite load (different event-loop/IO scheduling), never in isolation.

## Fix

`close()` now sets a `#closed` flag (only once the sink actually has a path — see below);
`emit()`/`attach()` check it first and drop the write, counting it as a failure, instead of
scheduling one. A write after close is now a deterministic no-op, not a race.

`close()` only sets `#closed` when `this.#path !== undefined`. Before a header ever arrives there
is no run yet (the constructor's own doc comment: the run's identity comes from the header's
`runId`), so `#flush()` was already a no-op with no path. The existing test "keeps events buffered
until a header gives them a home" relies on calling `close()` once before any header (a no-op) and
continuing to use the same sink afterward once a real trace starts — gating on `#path` keeps that
scenario working without weakening the post-close guarantee, since a "run" hasn't started until it
has a path.

**`failures` decision:** a post-close write now increments `#failures`. The getter's own doc says
failures are "surfaced rather than hidden: a truncated trace must not read as a clean one" — if a
post-close write were silently dropped without counting, `failures === 0` while real data was lost,
which contradicts that documented purpose. No existing test asserted `failures === 0` in a way this
breaks, and grep found no in-repo caller of `sink.close()` outside tests at all — `TraceSink` the
port doesn't even declare `close()`; it's `JsonlTraceSink`-specific, and its lifecycle is entirely
owned by whatever host constructs the sink. So there is no known production emit-after-close path
today; the guard is defensive against a caller-contract violation, not a fix for an observed bug
elsewhere.

## Test changes

- The existing "cut short" test kept its core assertion (attachment written before `close()` stays
  readable) but dropped the `shot(1)` call after `close()` — that was simulating a crash via an
  explicit `close()`, which isn't actually a crash, just a caller-contract violation; conflating
  the two was the root of the flake.
- Added a new test, "drops writes offered after close instead of racing to flush them (#199)",
  that explicitly asserts writes after `close()` are dropped deterministically and counted in
  `failures`.

## Result

- `npx vitest run packages/harness/test/adapters/sinks/jsonl.test.ts` × 20 in a loop: 20/20 pass.
- `npm test` × 2: 36/36 test files, 851/851 tests, both runs.
- `npm run typecheck`: clean.

## Follow-up: restoring the truncation test's teeth

Review caught that removing `shot(1)` from the "cut short" test left it proving almost exactly
what "files attachment bytes as sidecars a reader resolves by name alone (#160)" already proves —
a plain successful close, nothing cut short, and no assertion left on the actual invariant
(`#flush()` writes attachment bytes before appending the line that references them).

The reviewer's first suggested mechanism — emit several attachment-bearing steps, close, then walk
every prefix of the final `jsonl` lines checking each referenced attachment exists on disk — turned
out not to work, and I verified this empirically rather than assuming: implemented it, then
temporarily swapped the two `await`s inside `#flush()` (attachments-then-append →
append-then-attachments) and reran the file. It stayed green. Root cause: `Tracer.emit()` calls
`sink.attach()` then `sink.emit()` synchronously with no `await` between them, so a run of several
shots issued back-to-back never yields to the event loop — every `attach`/`emit` call lands in the
buffer before the queue's first scheduled `#flush()` microtask even runs. That collapses the whole
batch into one `#flush()` invocation, and since nothing crashes, both the attachment writes and the
append complete before `close()` resolves regardless of their internal order. Reading the finished
file after a clean `close()` cannot distinguish the two orderings — by definition, both are done by
read time.

Replaced it with a `vi.mock("node:fs/promises", ...)` interception (a direct `vi.spyOn` fails:
`Cannot redefine property: writeFile` — the module's own named exports are non-configurable, so
`vi.mock` is required, not just spy). The mock passes every call straight through to the real
implementation for all other tests in the file; only this one test overrides `writeFile`/
`appendFile` for its duration (restored in a `finally`). The `appendFile` override checks, at the
exact moment a chunk of lines is about to be written, that every attachment id it references is
already in a `written` set populated by completed `writeFile` calls — that is a check on real
call order, not a read of the finished file, so it cannot pass by accident once both operations
are done. Verified the same way as the fix itself: swapped the two `await`s in `#flush()` again and
reran — this time it goes red (`sink.failures` becomes 1, from the thrown ordering error landing in
`#schedule()`'s `.catch()`), then reverted the swap and confirmed green again.

Renamed to "writes attachment bytes before the line that references them (#199)" — kept to one
test per the review's ask, replacing rather than duplicating the line-134 test.

Re-verification: `npx vitest run .../jsonl.test.ts` × 20 in a loop → 20/20 pass. `npm test` × 2 →
36/36 files, 852/852 tests (851 + this one), both clean. `npm run typecheck` → clean.

## State change

None — this is a bug fix within `packages/harness`, no architecture or contract change to record
in `spec/journal/state.md` (not touched here per §5, develop-only).
