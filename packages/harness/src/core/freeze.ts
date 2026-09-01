/**
 * Freeze-time target stability scoring (#14). A frozen target's locators decide how well replay
 * survives UI change: a text-only target breaks on a rename and forces a `self-heal` (LLM re-entry
 * — cost + non-determinism); a `selector` or a `role`+`index` fallback survives it. Scoring and
 * warning at freeze time lets the author strengthen weak targets up front, lowering the self-heal
 * trigger rate. Pure — no I/O, no LLM (invariant #4).
 */
import type { Scenario, Step, Target } from "./types.js";
import type { TraceEvent } from "./trace.js";

export interface TargetScore {
  /** 0..1 estimate of how well the target survives UI change. */
  score: number;
  /** below the warn threshold — likely to force a self-heal later. */
  weak: boolean;
  reason: string;
}

const SELECTOR = 1; // CSS / test-id — most stable across UI change
const RESILIENT = 0.7; // role + structural index — survives a rename
const NAMED_NTH = 0.6; // text + nth — the designed address for duplicate labels (#92)
const TEXT_ONLY = 0.3; // accessible name only — a rename breaks it
const NONE = 0; // nothing to locate by

/** Score how well a single frozen target survives UI change. */
export function scoreTarget(target: Target): TargetScore {
  if (target.selector) {
    return { score: SELECTOR, weak: false, reason: "selector — stable across UI change" };
  }
  const hasIndex = target.role !== undefined && target.index !== undefined;
  if (hasIndex) {
    const how = target.text ? "text + role/index fallback" : "role + structural index";
    return { score: RESILIENT, weak: false, reason: how };
  }
  if (target.text && target.nth !== undefined) {
    // Not penalized like a weak text-only target: for identically-named elements nth IS the
    // strengthening — the name survives UI change and the position re-derives after a heal.
    return { score: NAMED_NTH, weak: false, reason: "text + nth — addresses the Nth of several same-named elements" };
  }
  if (target.text) {
    return {
      score: TEXT_ONLY,
      weak: true,
      reason: "text-only — a rename will force a self-heal; add a role/index fallback or a selector",
    };
  }
  return { score: NONE, weak: true, reason: "no locator" };
}

/** A step's target paired with its stability score. */
export interface ScoredTarget {
  stepIndex: number;
  step: Step;
  target: Target;
  score: TargetScore;
}

function stepTarget(step: Step): Target | undefined {
  return "target" in step ? step.target : undefined;
}

/** Score every located step in a scenario — caller decides what to do with the weak ones. */
export function scoreScenario(scenario: Scenario): ScoredTarget[] {
  const out: ScoredTarget[] = [];
  scenario.steps.forEach((step, stepIndex) => {
    const target = stepTarget(step);
    if (target) out.push({ stepIndex, step, target, score: scoreTarget(target) });
  });
  return out;
}

/** The weak targets in a scenario — flag these at freeze time so the author can strengthen them. */
export function weakTargets(scenario: Scenario): ScoredTarget[] {
  return scoreScenario(scenario).filter((s) => s.score.weak);
}

/** A run of blind key presses discover emitted instead of resolved click/type targets (#61). */
export interface GuessedKeyRun {
  startIndex: number;
  keys: string[];
}

/** Flag blind pressKey chains at freeze time: a Tab anywhere, or ≥2 consecutive key presses, is
 * focus-guessing — it can land on the wrong element (or nothing) and still pass coarse assertions
 * (#61). A single non-Tab press (an Enter submit after typing) is a normal pattern and not flagged. */
export function guessedKeyRuns(scenario: Scenario): GuessedKeyRun[] {
  const out: GuessedKeyRun[] = [];
  for (let i = 0; i < scenario.steps.length; ) {
    if (scenario.steps[i]!.kind !== "pressKey") {
      i++;
      continue;
    }
    const start = i;
    const keys: string[] = [];
    while (i < scenario.steps.length) {
      const step = scenario.steps[i]!;
      if (step.kind !== "pressKey") break;
      keys.push(step.key);
      i++;
    }
    if (keys.length >= 2 || keys.some((k) => /\bTab\b/i.test(k))) out.push({ startIndex: start, keys });
  }
  return out;
}

/**
 * Does this freeze carry a check that only the flow can satisfy? A live (non-vacuous)
 * `request-status` is the strongest form — it proves work happened rather than a page being
 * reached — but a `custom` check the product registered and an `expect` criterion frozen under
 * `--semantic` are checks someone authored for this flow too, and calling a scenario unverified
 * because of their kind would be false. What remains outside this set is a bare `navigated` and
 * the two guards, which pass as soon as the page loads clean.
 *
 * It still over-warns on a genuinely read-only flow, which has no action to prove; that is the
 * loud direction and is left as is.
 */
export function provesAnAction(scenario: Scenario): boolean {
  return scenario.assertions.some(
    (a) => (a.kind === "request-status" || a.kind === "custom" || a.kind === "expect") && a.vacuous !== true,
  );
}

/**
 * The reason a grounding gate dropped a proposed `request-status` — or `undefined` for any other
 * event. These are the lines worth reading next to a freeze that ended up with no proof: the most
 * common is a check the model invented that no captured request matched, and the rest are the
 * freeze refusing a value it could not make replayable (no stable path, a widening that would
 * match a different endpoint). Drops of other kinds — an `expect` without `--semantic` — stay
 * trace-only.
 *
 * A dropped proof does not fail the scenario by itself: a surviving `navigated` still passes it.
 * Whether to warn is therefore decided by what the freeze CARRIES, not by what it dropped; these
 * reasons only explain a freeze already found wanting.
 */
export function droppedProofReason(event: TraceEvent): string | undefined {
  if (event.kind !== "gate" || event.payload.gate !== "grounding" || !event.payload.action) return undefined;
  try {
    const proposed = JSON.parse(event.payload.action) as { kind?: unknown };
    return proposed.kind === "request-status" ? event.payload.reason : undefined;
  } catch {
    return undefined;
  }
}
