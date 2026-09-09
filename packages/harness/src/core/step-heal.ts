/**
 * Default StepHealer: when a step's `expect` fails at replay, re-decide a single action from the
 * step's `intent` and the live page, then re-freeze it in place — surgical, not a whole re-discovery.
 * The LLM (LlmClient port) runs only here, only on divergence (invariant #4(b)). See spec/core/surgical-heal.md.
 */
import type { Driver, LlmClient, StepHeal, StepHealer, PerceptionAdapter } from "./ports.js";
import type { Step } from "./types.js";
import { redactSecrets, slotSecretText } from "./secrets.js";
import type { Secrets } from "./secrets.js";
import { applyDecision, parseDecision, type Decision, type ActionPolicy } from "./discover/index.js";
import { describeAmbiguity } from "./discover/decision.js";
import { ACTION_RULES, PERCEPTION_RULES } from "./discover/prompt.js";
import { PerceptionObservation } from "./observation.js";

export interface StepHealOptions {
  policy?: ActionPolicy;
  perceive?: PerceptionAdapter;
}

const MAX_STEP_HEALS = 5;

const STEP_HEAL_SYSTEM =
  PERCEPTION_RULES + ACTION_RULES +
  "You repair ONE step of a browser QA scenario that ran but didn't reach its expected outcome. " +
  "Given the step's goal and the current page elements, reply with the SINGLE next action that " +
  'achieves the goal, as one JSON action object (same format as discovery: {"action":"click","text":"..."}). ' +
  'If nothing on the page can achieve it, reply {"action":"done"}. JSON only, no prose.';

export class LlmStepHealer implements StepHealer {
  readonly heals: StepHeal[] = [];
  constructor(
    private readonly llm: LlmClient,
    private readonly maxHeals = MAX_STEP_HEALS,
    /** Values for `{name}` placeholders (#174): the healer types them and never writes them. */
    private readonly secrets: Secrets = {},
    private readonly options: StepHealOptions = {},
  ) {}

  async heal(step: Step, index: number, driver: Driver): Promise<StepHeal | null> {
    if (this.heals.length >= this.maxHeals) return null;
    const raw = await driver.snapshot({ perception: true });
    const elements = redactSecrets(this.options.perceive ? await this.options.perceive(raw.map(e => ({ ...e }))) : raw, this.secrets);
    let decision: Decision;
    try {
      const page = new PerceptionObservation(driver, raw, elements, step.intent ?? step.kind);
      const reply = await this.llm.complete(stepHealPrompt(step, page), { system: STEP_HEAL_SYSTEM });
      decision = parseDecision(reply);
      if (decision.action === "type" && decision.value !== undefined) decision.value = slotSecretText(decision.value, this.secrets);
      decision = page.bind(decision);
      if (describeAmbiguity(decision, elements)) return null;
      if (this.options.policy) {
        const evidence = await driver.observe();
        if (!this.options.policy.vet(decision, { elements, url: evidence.execution.finalUrl }).ok) return null;
      }
    } catch {
      return null;
    }
    if (decision.action === "done") return null;
    let healed: Step;
    try {
      healed = await applyDecision(driver, decision, this.secrets); // slots and scopes a secret itself
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

function stepHealPrompt(step: Step, page: PerceptionObservation): string {
  return [
    `Step goal: ${step.intent ?? step.kind}`,
    `Expected outcome: ${step.expect ? JSON.stringify(step.expect) : "(reach the next state)"}`,
    ``,
    `Current page:`,
    page.render,
    page.references,
    ``,
    `Reply with the single next action that achieves the goal.`,
  ].join("\n");
}
