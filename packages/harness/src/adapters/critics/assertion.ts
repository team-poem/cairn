/** Deterministic Critic for the replay path — checks assertions against evidence, no LLM (invariant #4). */
import type { Critic } from "../../core/ports.js";
import type { Assertion, AssertionResult, Evidence, Verdict } from "../../core/types.js";

/** A product-defined check for a `{ kind: "custom", name }` assertion — the host decides what success means. */
export type CustomCheck = (
  params: Record<string, unknown>,
  evidence: Evidence,
) => boolean | { passed: boolean; detail?: string } | Promise<boolean | { passed: boolean; detail?: string }>;

export type CustomChecks = Record<string, CustomCheck>;

/** Resolve any assertion — a registered `custom` handler, else the built-in mechanical check. */
export async function resolveAssertion(
  assertion: Assertion,
  evidence: Evidence,
  custom: CustomChecks = {},
): Promise<AssertionResult> {
  if (assertion.kind === "custom") {
    const handler = custom[assertion.name];
    if (!handler) return { assertion, passed: false, detail: `no custom check registered for "${assertion.name}"` };
    const r = await handler(assertion.params ?? {}, evidence);
    return typeof r === "boolean" ? { assertion, passed: r } : { assertion, passed: r.passed, detail: r.detail };
  }
  return checkAssertion(assertion, evidence);
}

/** Requests whose failure is noise, not a regression — excluded from `no-failed-requests`. */
function isBenignRequest(url: string): boolean {
  return /\/favicon\.ico(\?|$)/i.test(url) || /\/robots\.txt(\?|$)/i.test(url);
}

/** Evaluate one mechanical assertion. `expect` is not mechanical — returns unsupported (LlmCritic handles it). */
export function checkAssertion(assertion: Assertion, evidence: Evidence): AssertionResult {
  switch (assertion.kind) {
    case "navigated": {
      const { navigated, finalUrl } = evidence.execution;
      if (!navigated) return { assertion, passed: false, detail: "no navigation occurred" };
      if (assertion.to && !(finalUrl ?? "").includes(assertion.to)) {
        return { assertion, passed: false, detail: `final url ${finalUrl} does not include ${assertion.to}` };
      }
      return { assertion, passed: true, detail: finalUrl };
    }
    case "no-console-errors": {
      const errors = evidence.logic.console.filter((m) => m.type === "error");
      return errors.length === 0
        ? { assertion, passed: true }
        : { assertion, passed: false, detail: `${errors.length} console error(s): ${errors[0]?.text}` };
    }
    case "no-failed-requests": {
      // Ignore universally-benign noise (a missing favicon shouldn't fail a checkout test).
      const failed = evidence.logic.requests.filter((r) => r.status >= 400 && !isBenignRequest(r.url));
      return failed.length === 0
        ? { assertion, passed: true }
        : { assertion, passed: false, detail: `${failed.length} failed request(s): ${failed[0]?.status} ${failed[0]?.url}` };
    }
    case "request-status": {
      const match = evidence.logic.requests.find((r) => r.url.includes(assertion.urlIncludes));
      if (!match) return { assertion, passed: false, detail: `no request matching ${assertion.urlIncludes}` };
      return match.status === assertion.status
        ? { assertion, passed: true, detail: `${match.status} ${match.url}` }
        : { assertion, passed: false, detail: `expected ${assertion.status}, got ${match.status} for ${match.url}` };
    }
    case "expect":
      return { assertion, passed: false, detail: "'expect' is judged by LlmCritic, not the deterministic critic" };
    case "custom":
      return { assertion, passed: false, detail: `custom check "${assertion.name}" needs a registered handler` };
  }
}

export class AssertionCritic implements Critic {
  /** @param custom product-defined checks for `custom` assertions, keyed by name. */
  constructor(private readonly custom: CustomChecks = {}) {}

  async judge(evidence: Evidence, assertions: Assertion[]): Promise<Verdict> {
    const results = await Promise.all(assertions.map((a) => resolveAssertion(a, evidence, this.custom)));
    return { passed: results.every((r) => r.passed), results };
  }
}
