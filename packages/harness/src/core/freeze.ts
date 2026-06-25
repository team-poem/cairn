/**
 * Freeze-time target stability scoring (#14). A frozen target's locators decide how well replay
 * survives UI change: a text-only target breaks on a rename and forces a `self-heal` (LLM re-entry
 * — cost + non-determinism); a `selector` or a `role`+`index` fallback survives it. Scoring and
 * warning at freeze time lets the author strengthen weak targets up front, lowering the self-heal
 * trigger rate. Pure — no I/O, no LLM (invariant #4).
 */
import type { Scenario, Step, Target } from "./types.js";

export interface TargetScore {
  /** 0..1 estimate of how well the target survives UI change. */
  score: number;
  /** below the warn threshold — likely to force a self-heal later. */
  weak: boolean;
  reason: string;
}

const SELECTOR = 1; // CSS / test-id — most stable across UI change
const RESILIENT = 0.7; // role + structural index — survives a rename
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
