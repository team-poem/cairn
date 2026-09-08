import { hostAuthority, hostIsAllowed, parseHostAuthority, parseReplayUrl } from "./hosts.js";
import type { Scenario, Step, WaitUntil } from "./types.js";

/** A runtime origin and the exact source hosts whose frozen page URLs may move there. */
export interface ReplayEnvironment {
  baseUrl: string;
  /** Exact hosts; DNS/IDN/IPv6 spellings normalize, while explicit ports stay scoped. */
  allowedHosts: readonly string[];
}

/** Validate before any browser/LLM work; return normalized config without mutating caller data. */
export function validateReplayEnvironment(environment: ReplayEnvironment): ReplayEnvironment {
  let base: URL;
  try {
    if (typeof environment?.baseUrl !== "string" || !/^https?:\/\/[^/?#\\]+\/?$/i.test(environment.baseUrl)
      || environment.baseUrl !== environment.baseUrl.trim()) throw new Error();
    base = new URL(environment.baseUrl);
    if (base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new Error();
  } catch {
    throw new Error("replayEnvironment.baseUrl must be an HTTP(S) origin without credentials, path, query, or hash");
  }
  if (!Array.isArray(environment.allowedHosts) || !environment.allowedHosts.length) {
    throw new Error("replayEnvironment.allowedHosts must be a nonempty list of exact hosts");
  }
  const allowedHosts = environment.allowedHosts.map((authority: string) => {
    const host = parseHostAuthority(authority);
    if (!host) {
      throw new Error("replayEnvironment.allowedHosts entries must be exact host[:port] values without schemes, paths, or wildcards");
    }
    return hostAuthority(host);
  });
  return { baseUrl: base.origin, allowedHosts: [...new Set(allowedHosts)] };
}

/** Return a runtime copy, preserving the frozen input and identity of targets/custom data. */
export function reanchorScenario(scenario: Scenario, environment: ReplayEnvironment): Scenario {
  environment = validateReplayEnvironment(environment);
  const base = new URL(environment.baseUrl);
  const pageUrl = (value: string, entry = false): string => {
    const source = parseReplayUrl(value);
    if (!source || !hostIsAllowed(source.host, environment.allowedHosts)) return value;
    // A host-only expectation keeps its original scope; goto still needs the root page.
    if (!entry && !source.suffix.startsWith("/")) return value;
    return `${source.absolute ? base.origin : base.host}${source.suffix || "/"}`;
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
