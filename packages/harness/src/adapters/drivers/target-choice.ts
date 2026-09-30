import { stepError } from "../../core/errors.js";
import { slotSecretText, type Secrets } from "../../core/secrets.js";
import { validTargetAnswer, type TargetChoicePilot, type TargetChoiceAudit } from "../../core/target-choice.js";
import type { Target } from "../../core/types.js";
import type { SelfHealOptions } from "./self-heal.js";

export interface TargetChoiceRepairOptions extends TargetChoicePilot {
  context: (target: Target) => { intent: string; stepRef: number } | undefined;
  onDecision?: (audit: TargetChoiceAudit, stepRef: number) => void;
  secrets?: Secrets;
}

/** Compose finite-choice policy explicitly; legacy/browser healing does not load this module. */
export function createTargetChoiceRepair(opts: TargetChoiceRepairOptions): NonNullable<SelfHealOptions["choice"]> {
  const threshold = opts.minConfidence;
  if (threshold !== null && (threshold === undefined || !Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
    throw new Error("target choice confidence threshold must be null or between 0 and 1");
  }
  return { prepare(target) {
    const context = opts.context(target);
    if (!context) throw stepError("resolution", "target choice requires original intent and post-condition evidence");
    return async (page, elements) => {
      const candidates = page.candidates();
      // No shortlist or name-only fallback: every retained candidate needs exact addressing.
      if (page.omittedCount || elements.some(e => e.occluded !== true && !e.ref) || !candidates.length) {
        throw stepError("resolution", "target choice requires a complete nonempty reference table within the candidate limit");
      }
      const keys = candidates.map(c => c.key);
      const selected = await opts.selector.select({ observationId: page.id,
        original: Object.fromEntries(Object.entries(target).map(([k, v]) => [k, typeof v === "string" ? slotSecretText(v, opts.secrets) : v])),
        intent: slotSecretText(context.intent, opts.secrets),
        candidates: candidates.map(c => ({ ...c, name: slotSecretText(c.name, opts.secrets) })),
      });
      const answer = selected.answer;
      const valid = !selected.error && validTargetAnswer(answer, [...keys, "none"]);
      const outcome = !valid ? "rejected" : answer!.choice === "none" ? "none" :
        threshold === null ? "threshold-unset" : answer!.confidence < threshold ? "low-confidence" : "selected";
      opts.onDecision?.({ ...selected, policyVersion: "cairn-target-policy/1", observationId: page.id, candidateKeys: keys,
        minConfidence: threshold, fallback: "fail", outcome }, context.stepRef);
      if (outcome !== "selected") throw stepError("resolution", `target choice withheld: ${selected.error ?? outcome}`);
      if (candidates.find(c => c.key === answer!.choice)?.disabled) throw stepError("resolution", "target choice selected a disabled candidate");
      return answer!.choice;
    };
  } };
}
