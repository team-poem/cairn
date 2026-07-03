/**
 * The discover loop — the only place the agent loops (invariant #3). It observes the page,
 * asks the LLM for the next action, acts, and repeats until done, emitting a Scenario that
 * later replays with no LLM (invariant #4). LLM is behind the LlmClient seam (invariant #5).
 *
 * Module layout: prompt (LLM surface) · decision (Decision→Step + shared execution) ·
 * capture (per-step expect) · grounding (freeze-time assertions). This file owns only the loop.
 */
import type { Driver, LlmClient } from "../ports.js";
import type { Assertion, Scenario, Step } from "../types.js";
import { ELEMENT_LIMIT, SYSTEM, buildPrompt, rankElements, renderElements } from "./prompt.js";
import { applyDecision, describeAction, parseDecision } from "./decision.js";
import type { ActionPolicy, Decision } from "./decision.js";
import { stepExpect } from "./capture.js";
import { deriveAssertions, proposeAssertions } from "./grounding.js";

export type { ActionPolicy, Decision, PolicyVerdict } from "./decision.js";
export { applyDecision, decisionToStep, parseDecision } from "./decision.js";
export { rankElements, renderElements } from "./prompt.js";

export interface DiscoverOptions {
  driver: Driver;
  llm: LlmClient;
  baseUrl?: string;
  maxSteps?: number;
  onStep?: (decision: Decision, step?: Step) => void;
  /** Abort discovery between steps (a host's Stop button). */
  signal?: AbortSignal;
  /**
   * Allow the freeze to carry LLM-judged `expect` assertions (semantic checks). Off by default:
   * `expect` needs an LlmCritic at replay, so the deterministic critic fails it (invariant #4).
   * When off, only evidence-grounded mechanical assertions are frozen — replay stays LLM-free.
   */
  semanticChecks?: boolean;
  /** Gate proposed actions (block destructive controls, cap wandering, stop on a goal). Absent → no
   * gate (every action runs) — behaviour unchanged. */
  policy?: ActionPolicy;
}

export async function discover(intent: string, opts: DiscoverOptions): Promise<Scenario> {
  const { driver, llm, baseUrl, maxSteps = 20, onStep, signal, semanticChecks = false, policy } = opts;
  const steps: Step[] = [];

  // Emit the freeze: observe, propose+ground assertions, done. `truncated` marks a step-cap stop.
  const finish = async (truncated: boolean, proposed: Assertion[] = []): Promise<Scenario> => {
    const evidence = await driver.observe();
    const all = [...proposed, ...(await proposeAssertions(llm, intent, evidence, semanticChecks))];
    const assertions = deriveAssertions(all, evidence, semanticChecks);
    return truncated
      ? { name: intent, steps, assertions, truncated: true }
      : { name: intent, steps, assertions };
  };

  if (baseUrl) {
    await driver.goto(baseUrl);
    steps.push({ kind: "goto", url: baseUrl });
  }

  // Remember what already failed so the LLM stops retrying dead ends (real sites have
  // hover menus, overlays, maintenance pages). ADAPT is the point of the loop (invariant #3).
  const failures: string[] = [];
  let prevRender = "";
  for (let i = 0; i < maxSteps; i++) {
    signal?.throwIfAborted();
    if (policy?.stop?.(steps)) return finish(false); // policy ended discovery (goal reached / bound hit)
    await driver.settle();
    const elements = await driver.snapshot();
    const render = renderElements(rankElements(elements, intent, ELEMENT_LIMIT));
    const reply = await llm.complete(buildPrompt(intent, render, prevRender, steps, failures), {
      system: SYSTEM,
    });
    prevRender = render;

    let decision: Decision;
    try {
      decision = parseDecision(reply);
    } catch {
      // A malformed reply must not kill the whole discovery — nudge and retry.
      failures.push("your previous reply was not a single valid JSON action object");
      continue;
    }

    if (decision.action === "done") {
      onStep?.(decision);
      return finish(false, decision.assertions ?? []);
    }

    // Policy gate: a rejected action never executes — recorded as a failure so the LLM re-decides.
    const verdict = policy?.vet(decision) ?? { ok: true as const };
    if (!verdict.ok) {
      failures.push(`${describeAction(decision)} — blocked by policy: ${verdict.reason}`);
      onStep?.(decision);
      continue;
    }

    try {
      const beforeObs = await driver.observe();
      const before = { url: beforeObs.execution.finalUrl, requests: beforeObs.logic.requests };
      const step = await applyDecision(driver, decision);
      // Capture for surgical-heal: intent (heal rationale) + a grounded per-step post-condition.
      if (decision.reason?.trim()) step.intent = decision.reason.trim();
      const expect = await stepExpect(driver, before);
      if (expect) step.expect = expect;
      steps.push(step);
      onStep?.(decision, step);
    } catch (err) {
      failures.push(`${describeAction(decision)} — ${err instanceof Error ? err.message : String(err)}`);
      onStep?.(decision);
    }
  }

  // Safety cap reached without an explicit "done" — flag it so the path isn't trusted as complete.
  return finish(true);
}
