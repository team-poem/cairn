# Trace — unified lifecycle event contract

> Status: **draft** for #138 (basis: the #125 agreements + the four trust criteria).
> Not implemented; field names here bind only when this doc lands.

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
  "payload": { "version": "1.0", "runId": "…", "engine": { "name": "cairn", "version": "2.5.0" } } }
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
| discover | `gate` | `gate: policy \| ambiguity \| grounding`, what was blocked/dropped, why | `ActionPolicy` vet (#77) · nth refusal (#127) · grounding drop (#16) |
| discover | `freeze` | `ref`, `caseHash`, assertion counts by origin, `truncated?` | `SkillStore.freeze` |
| replay | `step` | `ok`, `skipped?`, `error?`, `attachment?` (screenshot ref) | `StepProgress` |
| replay | `assertion` | the assertion, `passed`, `detail?`, `origin`, `checkedBy` | `AssertionResult` |
| heal | `heal` | `broke` (failed `expect` + error) → `became` (corrective step), `judgedBy: original` | `StepHeal` |

**Gate firings are first-class events, not silence** — a policy block, an ambiguity refusal, or
a grounding drop each changed what the engine did; a trace that omits them shows a cleaner run
than the one that happened.

## Trust — what each criterion demands of the payloads

| criterion | contract answer |
|---|---|
| *what green means* | every `assertion` event carries `origin: user \| derived` (user = merged from `SuiteCase.expect`/`assertions` at freeze; derived = `deriveAssertions` grounding) and `checkedBy: code \| model` (mechanical kinds = code; `expect` criterion = `LlmCritic`). A report can then say "12/20 cases verified against *user* criteria" instead of pretending all greens are equal. |
| *visibility into what ran* | `step` events with per-step screenshots (attachment refs) + `action` events carrying discover's `intent` — the trace shows both what was done and *why the model chose it*. |
| *auditable heals* | a `heal` event records `broke → became` and asserts `judgedBy: original` — the original step stays in the trace as the earlier `step` event (flat model: nothing is overwritten), and the verdict is still judged by the **original** assertions (surgical-heal P2 stance). Audit = diff two events. |
| *operational record* | "200 runs, 2 heals, 1 real regression" is a *fold over stored traces* — countable from `case-end` + `heal` events with no extra bookkeeping. The contract adds nothing; it just refuses to lose the inputs. |

## Attachments — refs in the payload, bytes in the serialization

Leaning (open in #138): the payload never carries binary — a `step` event says
`attachment: "<id>"`. Each **serialization** decides where bytes live: the live stream MAY
inline a data URL for immediacy; the stored artifact keeps sidecar files keyed by id (a trace
you can `less`, attachments you can `open`). Same model, two serializations — applied to bytes.

## Versioning — header `major.minor`

- **minor** = additive: a new `kind`, a new optional payload field. Viewer rule: skip unknown
  kinds/fields *but count them* ("3 events this viewer doesn't render") — never silently drop.
- **major** = envelope or semantics change. Viewer rule: refuse with a clear message, don't
  guess.

## Out of contract (separate tracks)

- **Ratification / review UX** — runner-side concern.
- **Flake detection** — the red-side trust axis ("is this red real?"); needs accumulated real
  cases before a mechanism is worth designing.

## Open

- `assertion` events: live per-assertion feed (as drafted) vs. only the aggregate in
  `case-end` — is the live feed worth the event count?
- Attachment id scheme (content hash vs. `seq`-derived).
- Does `explore` mode emit under `discover` or earn its own phase value?
