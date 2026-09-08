import type { Scenario, Step, WaitUntil } from "./types.js";

/** A runtime origin and the exact source hosts whose frozen page URLs may move there. */
export interface ReplayEnvironment {
  baseUrl: string;
  allowedHosts: readonly string[];
}

/** Return a runtime copy, preserving the frozen input and identity of targets/custom data. */
export function reanchorScenario(scenario: Scenario, environment: ReplayEnvironment): Scenario {
  const base = new URL(environment.baseUrl);
  const pageUrl = (value: string, entry = false): string => {
    const match = /^(https?:\/\/)?([^/?#]+)([/?#].*)?$/i.exec(value);
    if (!match || !environment.allowedHosts.includes(match[2]!.toLowerCase())) return value;
    const suffix = match[3];
    // A host-only expectation keeps its original scope; goto still needs the root page.
    if (!entry && (!suffix || !suffix.startsWith("/"))) return value;
    return `${match[1] ? base.origin : base.host}${suffix ?? "/"}`;
  };
  const condition = (until: WaitUntil): WaitUntil => {
    if (until.url === undefined) return until;
    const url = pageUrl(until.url);
    return url === until.url ? until : { ...until, url };
  };
  const steps = scenario.steps.map((step): Step => {
    let mapped = step;
    if (step.kind === "goto") {
      const url = pageUrl(step.url, true);
      if (url !== step.url) mapped = { ...step, url };
    } else if (step.kind === "waitFor") {
      const until = condition(step.until);
      if (until !== step.until) mapped = { ...step, until };
    }
    if (step.expect) {
      const expect = condition(step.expect);
      if (expect !== step.expect) mapped = { ...mapped, expect };
    }
    return mapped;
  });
  const assertions = scenario.assertions.map((assertion) => {
    if (assertion.kind !== "navigated" || assertion.to === undefined) return assertion;
    const to = pageUrl(assertion.to);
    return to === assertion.to ? assertion : { ...assertion, to };
  });
  return { ...scenario, steps, assertions };
}
