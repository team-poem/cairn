/**
 * Deterministic Critic: checks each assertion against the three-layer evidence.
 *
 * No LLM (invariant #4) — this is the critic the replay path uses. An LLM-backed Critic
 * for fuzzy judgment is a separate implementation behind the same interface.
 */
import type { Critic } from "../interfaces.js";
import type { Assertion, AssertionResult, Evidence, Verdict } from "../types.js";

function check(assertion: Assertion, evidence: Evidence): AssertionResult {
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
      const failed = evidence.logic.requests.filter((r) => r.status >= 400);
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
  }
}

export class AssertionCritic implements Critic {
  async judge(evidence: Evidence, assertions: Assertion[]): Promise<Verdict> {
    const results = assertions.map((a) => check(a, evidence));
    return { passed: results.every((r) => r.passed), results };
  }
}
