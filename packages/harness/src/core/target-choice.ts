/** A narrow decision seam for locator repair. No generated actions, values, or locators. */
import type { Target } from "./types.js";

export interface TargetCandidate {
  /** Engine-owned key, stable for this observation only; never a driver handle. */
  key: string;
  name: string;
  role: string;
  nth?: number;
  checked?: boolean | "mixed";
  disabled?: boolean;
  inActivePopup?: boolean;
  clickable?: boolean;
}

export interface TargetChoiceRequest {
  observationId: string;
  original: Target;
  intent: string;
  candidates: readonly TargetCandidate[];
}

export interface TargetChoiceResult {
  provider: string;
  requestedModel: string;
  model?: string;
  questionVersion: string;
  candidateSetId: string;
  requested: boolean;
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number };
  answer?: { choice: string; probabilities: Record<string, number>; confidence: number };
  error?: "empty-candidates" | "candidate-limit" | "missing-evidence" | "input-limit" | "credentials" | "timeout" | "api-error" | "invalid-response";
}

export interface TargetSelector {
  select(request: TargetChoiceRequest): Promise<TargetChoiceResult>;
}

export interface TargetChoicePilot {
  selector: TargetSelector;
  /** null collects the decision but abstains. No default production threshold. */
  minConfidence: number | null;
}

/** Decision evidence only: never contributes to the proof grade. Existing step/assertion events
 * supply execution, original post-condition and final verdict under the same case/step refs. */
export interface TargetChoiceAudit extends TargetChoiceResult {
  policyVersion: "cairn-target-policy/1";
  observationId: string;
  candidateKeys: string[];
  minConfidence: number | null;
  fallback: "fail";
  outcome: "selected" | "none" | "threshold-unset" | "low-confidence" | "rejected";
}

const record = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const unit = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;

/** Validate even a type-constrained provider: HTTP bodies remain an untrusted boundary. */
export function validTargetAnswer(answer: unknown, keys: readonly string[]): answer is NonNullable<TargetChoiceResult["answer"]> {
  if (!record(answer) || typeof answer.choice !== "string" || !keys.includes(answer.choice) ||
      !unit(answer.confidence) || !record(answer.probabilities)) return false;
  const probabilities = answer.probabilities;
  if (Object.keys(probabilities).length !== keys.length || !keys.every(k => Object.hasOwn(probabilities, k) && unit(probabilities[k]))) return false;
  const values = Object.values(probabilities) as number[];
  return Math.abs(values.reduce((a, b) => a + b, 0) - 1) <= 1e-6 &&
    probabilities[answer.choice] === Math.max(...values);
}
