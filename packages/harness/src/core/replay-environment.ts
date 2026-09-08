import type { Scenario, Step, WaitUntil } from "./types.js";

/** A runtime origin and the exact source hosts whose frozen page URLs may move there. */
export interface ReplayEnvironment {
  baseUrl: string;
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
  const allowedHosts = environment.allowedHosts.map((host: string) => {
    try {
      if (typeof host !== "string" || !host || /[\s/\\?#@*]/.test(host)) throw new Error();
      const url = new URL(`http://${host}`);
      if (!url.hostname || url.username || url.password || url.pathname !== "/") throw new Error();
      return host.toLowerCase();
    } catch {
      throw new Error("replayEnvironment.allowedHosts entries must be exact host[:port] values without schemes, paths, or wildcards");
    }
  });
  return { baseUrl: base.origin, allowedHosts: [...new Set(allowedHosts)] };
}

/** Return a runtime copy, preserving the frozen input and identity of targets/custom data. */
export function reanchorScenario(scenario: Scenario, environment: ReplayEnvironment): Scenario {
  environment = validateReplayEnvironment(environment);
  const base = new URL(environment.baseUrl);
  const pageUrl = (value: string, entry = false): string => {
    const match = /^(https?:\/\/)?([^/?#]+)([/?#].*)?$/i.exec(value);
    if (!match) return value;
    let host = match[2]!.toLowerCase();
    if (match[1]) {
      try {
        const source = new URL(value);
        if (source.username || source.password) return value;
        host = source.host;
      } catch { return value; }
    }
    if (!environment.allowedHosts.includes(host)) return value;
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
