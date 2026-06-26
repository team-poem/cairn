/**
 * Default StepHealer: when a step's `expect` fails at replay, re-decide a single action from the
 * step's `intent` and the live page, then re-freeze it in place — surgical, not a whole re-discovery.
 * The LLM (LlmClient port) runs only here, only on divergence (invariant #4(b)). See spec/core/surgical-heal.md.
 */
import type { Driver, LlmClient, StepHeal, StepHealer } from "./ports.js";
import type { PageElement, Step } from "./types.js";
import { applyDecision, parseDecision, renderElements, type Decision } from "./discover.js";

const MAX_STEP_HEALS = 5;

const STEP_HEAL_SYSTEM =
  "You repair ONE step of a browser QA scenario that ran but didn't reach its expected outcome. " +
  "Given the step's goal and the current page elements, reply with the SINGLE next action that " +
  'achieves the goal, as one JSON action object (same format as discovery: {"action":"click","text":"..."}). ' +
  'If nothing on the page can achieve it, reply {"action":"done"}. JSON only, no prose.';

export class LlmStepHealer implements StepHealer {
  readonly heals: StepHeal[] = [];
  constructor(
    private readonly llm: LlmClient,
    private readonly maxHeals = MAX_STEP_HEALS,
  ) {}

  async heal(step: Step, index: number, driver: Driver): Promise<StepHeal | null> {
    if (this.heals.length >= this.maxHeals) return null;
    const elements = await driver.snapshot();
    let decision: Decision;
    try {
      const reply = await this.llm.complete(stepHealPrompt(step, elements), { system: STEP_HEAL_SYSTEM });
      decision = parseDecision(reply);
    } catch {
      return null;
    }
    if (decision.action === "done") return null;
    let healed: Step;
    try {
      healed = await applyDecision(driver, decision);
    } catch {
      return null;
    }
    // Keep the original intent + expect on the re-frozen step so it stays verifiable next replay.
    healed.intent = step.intent;
    healed.expect = step.expect;
    const heal: StepHeal = { index, step: healed };
    this.heals.push(heal);
    return heal;
  }
}

function stepHealPrompt(step: Step, elements: PageElement[]): string {
  return [
    `Step goal: ${step.intent ?? step.kind}`,
    `Expected outcome: ${step.expect ? JSON.stringify(step.expect) : "(reach the next state)"}`,
    ``,
    `Current page:`,
    renderElements(elements),
    ``,
    `Reply with the single next action that achieves the goal.`,
  ].join("\n");
}
