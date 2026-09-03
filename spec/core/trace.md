# Trace — unified lifecycle event contract

> Status: **implemented** (#143) — the engine emits this stream through the `TraceSink` port,
> and ships the stored serialization as the `JsonlTraceSink` adapter (#160). Header version **1.2**.
> Field names bind.

## One line

Everything a run does becomes **one flat, ordered, versioned sequence of events** — the live
stream and the stored trace are two serializations of the same model — so a consumer can watch
it live, store it, replay it in a viewer, and *audit* what a green actually proved.

## Model (agreed in #125)

- Lifecycle: **run → case → phase** (`discover` · `replay` · `heal`).
- Events are **flat**. Correlation is by reference (`caseRef`, `stepRef`), never containment —
  heal events are not children of replay steps; presentation builds trees, the contract doesn't.
- Attach where it belongs: **usage** at run/case end · **verdict** at case end · **evidence**
  per step.
- A bare `runScenario` (no suite) is a run with **one implicit case** (`caseRef` = scenario
  name) — so every consumer reads one shape.

## Envelope — ordering + correlation + typing, nothing else

```jsonc
{ "seq": 12, "ts": 1789300000000, "phase": "replay", "kind": "step",
  "caseRef": "login", "stepRef": 3, "payload": { /* per-kind */ } }
```

| field | role | notes |
|---|---|---|
| `seq` | total order | monotonic per trace |
| `ts` | wall clock | epoch ms |
| `phase?` | phase scoping | `discover · replay · heal` — **absent on lifecycle events** (trace/run/case start·end) |
| `kind` | event typing | dispatch key; unknown kinds are skippable (compat rule below) |
| `caseRef?` | correlation | `SuiteCase.id`; absent on run-level events |
| `stepRef?` | correlation | step index in the (frozen) scenario |
| `payload` | the data | per-kind shape, evolves under the header version |

Deliberately **not** in the envelope: `version` (rides in the header event — once per trace,
below) and `level` (severity is derivable from `kind`; a viewer that wants a red/yellow/green
lane maps kinds, the contract doesn't pre-chew presentation — same stance as #125).

## Header — version once, first event

`kind: "trace"` is always `seq: 0`:

```jsonc
{ "seq": 0, "ts": ..., "kind": "trace",
  "payload": { "version": "1.2", "runId": "…", "engine": { "name": "cairn", "version": "2.5.0" } } }
```

- **Stored trace**: a file is read from the top → the header is naturally first.
- **Live stream**: mid-stream attach is a *transport* problem, not a contract problem — a
  subscribe API re-delivers the header (and current `case-start`) to a late joiner, the way a
  broadcast channel greets you with "you're on episode N". The contract stays
  serialization-agnostic; per-event `version` would be pure duplication.

## Kinds (per level / phase)

| level·phase | kind | payload carries | source of truth today |
|---|---|---|---|
| lifecycle | `trace` | `version`, `runId`, `engine` | — (new) |
| lifecycle | `run-end` | `passed`, `usage` | `SuiteResult` |
| lifecycle | `case-start` | `id`, `intent`, `skillRef`, `cached` (hit vs. discover) | `SuiteCase` + cache check |
| lifecycle | `case-end` | `verdict`, `usage`, `discovered`, `heals`, `truncated?` | `SuiteVerdict` |
| discover | `action` | proposed `step`, its `intent` (the reason), `ok`/`error` | discover loop |
| discover | `gate` | `gate: policy \| ambiguity \| grounding \| parse-retry \| unproven-action`, what was blocked/dropped/nudged/left unproven, why | `ActionPolicy` vet (#77) · nth refusal (#127) · grounding drop (#99) · malformed-reply nudge · an action no check can express (#184) |
| discover | `freeze` | `ref`, `caseHash`, assertion counts by origin, `truncated?`, `unprovenAction?` (`METHOD url`, #184) | `SkillStore.freeze` |
| replay | `step` | `ok`, `skipped?`, `error?`, `attachment?` (screenshot ref) | `StepProgress` |
| replay | `assertion` | the assertion, `passed`, `detail?`, `origin`, `checkedBy` | `AssertionResult` |
| heal | `heal` | `layer: locator \| step`, `broke` → `became`, `judgedBy: original` | locator `Heal` (`onHeal`) · `StepHeal` |

**Heal is three layers, one phase.** Locator heal (a target substitution) and surgical step heal
(a corrective step) each emit a `heal` event — `broke → became` is a target pair or a step pair,
told apart by `layer`. **Outcome-heal** (the full re-discovery in `run.ts`) is not one event: it
re-runs discovery, so it emits *the discover kinds* (`action` · `gate` · `freeze`) **under
`phase: heal`** — the phase says *why* it ran, the kinds say *what* ran. Implementable today:
outcome-heal calls `discover()` directly. Its verdict is still judged by the **original**
assertions (surgical-heal P2), which is what keeps the phase auditable.

**Gate firings are first-class events, not silence** — a policy block, an ambiguity refusal, or
a grounding drop each changed what the engine did; a trace that omits them shows a cleaner run
than the one that happened.

## Trust — what each criterion demands of the payloads

| criterion | contract answer |
|---|---|
| *what green means* | every `assertion` event carries `origin: user \| derived \| unknown` (user = merged from `SuiteCase.expect`/`assertions` at freeze; derived = `deriveAssertions` grounding; unknown = a skill frozen before provenance existed — see below) and `checkedBy: code \| model` (mechanical kinds = code; `expect` criterion = `LlmCritic`). A report can then say "12/20 cases verified against *user* criteria" instead of pretending all greens are equal. |
| *visibility into what ran* | `step` events with per-step screenshots (attachment refs) + `action` events carrying discover's `intent` — the trace shows both what was done and *why the model chose it*. |
| *auditable heals* | every heal layer leaves marks: locator/step heals as `heal` events recording `broke → became` with `judgedBy: original`; outcome-heal as a full `phase: heal` discover sequence. The original step stays in the trace as the earlier `step` event (flat model: nothing is overwritten), and the verdict is still judged by the **original** assertions (surgical-heal P2 stance). Audit = diff two events. |
| *operational record* | "200 runs, 2 heals, 1 real regression" is a *fold over stored traces* — countable from `case-end` + `heal` events with no extra bookkeeping. The contract adds nothing; it just refuses to lose the inputs. |

## Freeze-format implication — assertion provenance

`origin` cannot be reconstructed at replay: the suite merges user criteria into the frozen
assertion array (`suite.ts`) and `Assertion` carries no provenance marker, so "user vs. derived"
is lost the moment the freeze is written. The contract therefore requires an **additive skill-format
change**: freeze records `origin: "user" | "derived"` on each assertion. A skill frozen before
this shipped has no marker — readers surface those as `origin: "unknown"`, never guess (same
fail-closed stance as the missing-`caseHash` rule). Undeclared fields already ride through
`Scenario` unchanged, so old files stay loadable.

## Attachments — refs in the payload, bytes in the serialization

The payload never carries binary — a `step` event says
`attachment: "<id>"`. Each **serialization** decides where bytes live: the live stream MAY
inline a data URL for immediacy; the stored artifact keeps sidecar files keyed by id (a trace
you can `less`, attachments you can `open`). Same model, two serializations — applied to bytes.

**The id is the event's `seq`** (decided in #160). `seq` is unique and totally ordered by
construction, which is exactly what `(caseRef, stepRef)` is not: a heal re-runs a step, so the
same `stepRef` legitimately produces two frames — correlation by reference keeps one and loses
the other, which is fine for a viewer and wrong for an audit. Grammar: `<seq>`, or `<seq>-<k>`
if an event ever carries more than one attachment (suffix *within* the event — never a second
counter). The **Tracer stamps it**, since `seq` is the envelope's to assign; call sites hand the
emitter bytes and never an id.

**Sidecars resolve by naming convention alone** — no manifest, ever. A run that ends mid-write is
normal, so anything written at close is the wrong place for an index: the stored serialization
writes `<trace-file-without-extension>/<id>.<ext>` as each attachment arrives (with the
conventional path, that reads `<runId>/<seq>.png` next to `<runId>.jsonl`). A reader resolves an
id by looking for `<id>.*` there; the directory listing *is* the index, so every attachment a
truncated run already wrote stays readable.

**A sink that stores no bytes gets no refs.** `TraceSink.attach` is optional; when it is absent
the engine never captures a screenshot for the trace at all (same zero-cost stance as an absent
sink) and the field stays off the payload — a ref nothing can resolve is worse than no ref.

## Versioning — header `major.minor`

- **minor** = additive: a new `kind`, a new optional payload field. Viewer rule: skip unknown
  kinds/fields *but count them* ("3 events this viewer doesn't render") — never silently drop.
- **major** = envelope or semantics change. Viewer rule: refuse with a clear message, don't
  guess.

## Out of contract (separate tracks)

- **Ratification / review UX** — runner-side concern.
- **Flake detection** — the red-side trust axis ("is this red real?"); needs accumulated real
  cases before a mechanism is worth designing.

## Decided in review (#140)

- **Per-assertion live events stay** — the `case-end` rollup needs them anyway.
- **`explore` gets no phase value yet** — it earns one when someone actually asks for explore
  traces (invariant #7 spirit: vocabulary is earned, not added speculatively).

## Decided in implementation (#143)

- **The outcome-heal re-judgment emits `assertion` events under `phase: heal`** — the kinds
  table binds `assertion` to replay, but the outcome-heal rule ("the phase says *why* it ran,
  the kinds say *what* ran") extends to the verdict: the re-judged results are assertion events
  that ran *because* of a heal, and stamping them `replay` would hide that.
- **The model's `done` decision is an `action` event** — `{ done: true, ok: true, intent? }`,
  no `step`. Without it, a discovery that stopped on the model's own judgment is
  indistinguishable in the trace from one a `policy.stop` ended — "why discovery ended" is
  audit information, not silence.
- **A bare run's `case-start` says `cached: true`, read as "the scenario pre-existed"** — a bare
  `runScenario` was handed a scenario, so nothing was discovered this run; `cached` means
  "no discovery happened", not "a store served a hit" (a bare run has no store at all).
- **`case-end.heals` counts locator + step heals only** (mirror of `SuiteVerdict.heals`) — an
  outcome-heal is not in the count; it is visible as the `phase: heal` discover sequence itself,
  so counting it too would double-report the same repair.

## Decided in implementation (#160)

- **The stored serialization ships with the engine** (`JsonlTraceSink`) — the spec's "two
  serializations of one model" only holds if the engine carries both; otherwise every embedder
  re-implements persistence slightly differently and "a stored trace" stops being one format.
- **Attachment id = `seq`, sidecars by naming convention** (§Attachments) — closing the last
  open item. Header goes to **1.1**: `step.payload.attachment` is an additive optional field,
  so a 1.0 reader skips it under the minor rule.

## Decided in implementation (#190)

- **`freeze.payload.unprovenAction`** carries the #184 advisory (`METHOD url`) next to
  `truncated`, so a suite trace names the unproven action at the freeze, not only in the `gate`
  event — and `SuiteVerdict` carries the same field for the reporter line. Header goes to
  **1.2**: an additive optional field, minor rule.

## Open

- *(none — the attachment id scheme was the last one, closed in #160.)*
