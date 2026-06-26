# Design: surgical self-heal — per-step outcome verification

> Status: **implemented** on `feat/surgical-heal` — the keystone (#31: per-step `intent`/`expect`
> capture, deterministic skip + divergence detection, `StepHealer` port + `LlmStepHealer`, re-freeze)
> plus every follow-up it unlocked (#32–#40). Next: real-app dogfood via the extension.
> Basis: direct read of the 1.3.0 code + extension dogfooding + an A-grade review. A formalization of the accumulated cairn-feedback.

## 0. Root — the deepest single problem

> **cairn has no *per-step outcome verification*.**

Judgment happens **once, at the end** of a scenario (the single `runHarness` verdict). So a mid-scenario step that diverges — **if it doesn't throw** — stays invisible until the end (or forever). Almost every way cairn breaks on dynamic flows is a branch of this one root:

- mid-flow divergence is undetectable → self-heal is crude (whole re-discovery).
- a positional locator can silently pick the wrong element and never be caught.
- a heal can mask a regression → false green.
- it claims "three-layer evidence" yet the perception layer isn't used in judgment.

→ **The keystone that closes this root = a per-step `expect` (detection) + per-step `intent` (repair).**

## 1. Problem inventory (with code evidence)

### 🔴 Tier 1 — top-grade blockers (closed at once by the keystone)
- **P1 No per-step verification (root).** No critic reads `evidence.perception`, and `Step` has no post-condition field. Divergence is only seen in the end verdict.
- **P2 False green from heal-by-rediscovery.** `run.ts`'s re-discovery path builds *new* assertions via `proposeAssertions` and judges against those → a broken page that reaches a *different end-state* can be disguised as a pass. (The extension works around it by "judging against the original goal assertions" — **the cairn-side hole remains.**)
- **P3 Silent mis-selection by positional locator.** `resolveTargetUid`'s fallback = `sameRole[index]` → on reorder/insert it picks the wrong element **without throwing**. locate-heal doesn't fire (no throw) and there's no mid-step check → silent wrong click → silent wrong outcome.

### 🟡 Tier 2 — seam gaps
- **P4 discover can't produce `waitFor`.** discover's `SYSTEM` prompt action list has no `waitFor` → it can't auto-generate the readiness wait (auth race, etc.); a human must hand-edit the freeze.
- **P5 self-heal demotes locators to text-only.** Every heal does `click({text})` — dropping role/index. The opposite of what the freeze score recommends → every heal makes the scenario more brittle.
- **P6 perception captured but unused.** `Evidence.perception.screenshot` is never read → the "three-layer" claim is effectively two-layer. Either wire a visual assertion or correct the claim.

### 🟢 Tier 3 — tuning/policy
- **P7** hardcoded defaults (`maxSteps=8` is short for real funnels, timeouts, benign-request list not injectable).
- **P8** `rankElements` tokenization is English-biased (`split(/\W+/)` can't token-match Korean intents).
- **P9** `applyHeals` keys by `text` → two steps with the same label collide (fixed: key by target identity).
- **P10** a scenario truncated at the safety cap is frozen as if complete (no truncation signal).

## 2. The keystone — detection (`expect`) and repair (`intent`) are a *pair*

| Keystone | Role | How obtained |
|---|---|---|
| step `expect` (post-condition) | lets us *know* a step diverged | extend discover's end-of-run assertion proposal (`deriveAssertions`) **to per-step** |
| step `intent` | *how* to repair the diverging step | save the `reason` discover already produces, onto the `Step` (currently discarded → free) |

**How it closes Tier 1:** P1 (check `expect` after each step → detect mid-flow divergence) · P2 (instead of whole re-discovery, re-decide *only the diverging step* via `intent` → re-freeze; **keep the original goal assertions** → no false green) · P3 (even a silent wrong click is caught because that step's `expect` breaks).

**⚠️ Two design corrections (vs the earlier memo):**
1. **It's a pair, not a sequence.** Without `expect` (detection), `intent` (repair) can never even fire → put them in the same v1.
2. **Gate `skip` on the post-condition.** "already logged in → skip" (safe — that step's `expect` already holds) vs "couldn't do it → skip" (false pass): `expect` is the *only* thing that distinguishes them.

## 3. Mechanism (replay = deterministic + step surgery)

For each step:
1. **Check `expect` before executing** → if it already holds, **safe skip** (idempotency; e.g. already logged in).
2. Otherwise execute.
3. **Check `expect` after executing**:
   - holds → next step (still deterministic, no LLM).
   - violated → **heal only this step**: give the LLM `step.intent` + the current snapshot → a corrective decision (re-target / alternative, **preserving role/index locators** — P5) → execute → re-check `expect`.
4. The healed step → **re-freeze** (avoid P9: key by step position, not label).

No divergence (all `expect` hold) → **zero LLM.**

## 4. Types (minimal)

```ts
Step += {
  intent?: string;        // discover's per-action reason — what a heal re-decides from
  expect?: WaitUntil;      // post-condition checked after the step (detection)
};
```

`expect` reuses the existing `WaitUntil` (`{ url?, requestStatus?, text?, role? }`) — the same shape
`waitFor` blocks on, verified by the same `conditionMet()`, so per-step verification is deterministic
with no new type or port. v1 derives `expect` from a step's navigation (`{ url }`); request- and
element-based post-conditions are a follow-up.

## 5. Invariants (preserved)

- No divergence → **zero LLM (deterministic replay, #4).** LLM only in discovery + heal (#4(b) sanctioned).
- core ↔ adapter independence. `expect` is checked via `observe()`/`snapshot()` — **no new Driver method** (isomorphic to `waitFor`).
- No branching inside the Execute stage — step-heal goes through a handler/decorator seam (invariant #2).

## 6. Phasing + issue candidates

**P0 (top-grade blockers):**
1. `feat(replay): per-step post-condition + step intent — surgical self-heal` — introduce `expect` (detection) and `intent` (repair) together. No divergence → zero LLM.
2. `fix(heal): outcome-heal must judge against the *original* scenario's assertions (kill false green)` — `run.ts` re-discovery path judges by the original goal assertions; whole re-discovery → step-level surgery. (P2)
3. `fix(driver): role+index positional locator silently mis-selects on reorder` — add multiple anchors / post-selection verification + a reorder-churn bench. (P3)

**P1 (seam gaps):** 4. discover proposes/produces `waitFor` (P4) · 5. self-heal preserves role/index (P5) · 6. wire perception into judgment or correct the "three-layer" claim (P6).

**P2 (policy):** 7. injectable timeout/maxSteps/benign + Korean-aware intent ranking (P7·P8) · 8. `applyHeals` label collision (P9) · 9. truncation signal on safety-cap (P10).

## 7. Grade condition

> When surgical self-heal demonstrates — *in numbers* — "LLM only on the diverging step · zero LLM otherwise · convergence via re-freeze" on a real dynamic flow, and the same real app runs one full discover→freeze→replay loop, then every axis is A.
