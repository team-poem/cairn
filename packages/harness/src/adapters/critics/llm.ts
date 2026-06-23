/**
 * Critic that judges natural-language `expect` criteria with an LLM and delegates mechanical
 * assertions to the deterministic checker. The LLM runs ONLY for `expect`, so a scenario with
 * none makes zero LLM calls and stays deterministic (invariant #4). Judgment is grounded in the
 * three-layer evidence (design §6), behind the LlmClient seam (invariant #5).
 */
import { resolveAssertion } from "./assertion.js";
import type { CustomChecks } from "./assertion.js";
import type { Critic, LlmClient } from "../../core/ports.js";
import type { Assertion, AssertionResult, Evidence, Verdict } from "../../core/types.js";

const SYSTEM =
  "You are a QA critic. Given observed evidence from a browser run and a success " +
  "criterion, decide whether the criterion is satisfied. Judge only from the evidence; " +
  'do not assume. Respond with strict JSON, no prose, no code fences: {"passed":true|false,"detail":"<short reason>"}.';

/** Compact, judge-friendly rendering of the three evidence layers. */
export function summarizeEvidence(evidence: Evidence): string {
  const { execution, logic } = evidence;
  const requests = logic.requests
    .slice(0, 40)
    .map((r) => `${r.status} ${r.method} ${r.url}`)
    .join("\n");
  const errors = logic.console.filter((m) => m.type === "error").map((m) => m.text);
  return [
    `navigated: ${execution.navigated}`,
    `finalUrl: ${execution.finalUrl ?? "(none)"}`,
    `blocked: ${execution.blocked}`,
    `requests (${logic.requests.length}):`,
    requests || "(none)",
    `console errors (${errors.length}):`,
    errors.join("\n") || "(none)",
  ].join("\n");
}

function parseVerdict(text: string): { passed: boolean; detail?: string } {
  let s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`no JSON in critic reply: ${text.slice(0, 200)}`);
  const obj = JSON.parse(s.slice(start, end + 1)) as { passed?: unknown; detail?: unknown };
  return { passed: obj.passed === true, detail: typeof obj.detail === "string" ? obj.detail : undefined };
}

export class LlmCritic implements Critic {
  constructor(
    private readonly llm: LlmClient,
    private readonly custom: CustomChecks = {},
  ) {}

  private async judgeExpect(criterion: string, evidence: Evidence, assertion: Assertion): Promise<AssertionResult> {
    const prompt = [
      `Success criterion: ${criterion}`,
      ``,
      `Evidence:`,
      summarizeEvidence(evidence),
      ``,
      `Is the criterion satisfied? Respond with JSON only.`,
    ].join("\n");
    try {
      const reply = await this.llm.complete(prompt, { system: SYSTEM });
      const v = parseVerdict(reply);
      return { assertion, passed: v.passed, detail: v.detail ?? `judged by ${this.llm.id}` };
    } catch (err) {
      return { assertion, passed: false, detail: `LLM judgment failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async judge(evidence: Evidence, assertions: Assertion[]): Promise<Verdict> {
    const results = await Promise.all(
      assertions.map((a) =>
        a.kind === "expect"
          ? this.judgeExpect(a.criterion, evidence, a)
          : resolveAssertion(a, evidence, this.custom),
      ),
    );
    return { passed: results.every((r) => r.passed), results };
  }
}
