/**
 * Core data types for the cairn pipeline: Context → Plan → Execute → Judge → Report.
 *
 * These are domain-agnostic by invariant (#1 pattern ≠ data): the core knows nothing
 * about any particular app, environment, or connector. Environment-specific behavior
 * is injected through the interfaces in `interfaces.ts`, never baked into these shapes.
 */

/** Grounding assembled for a task before planning — what the agent knows going in. */
export interface Context {
  /** The natural-language intent the run is meant to satisfy. */
  intent: string;
  /** Optional starting URL for the target app. */
  baseUrl?: string;
  /** Free-form notes a ContextProvider may attach (docs, diffs, ticket text). */
  notes?: string[];
}

/** A single browser action. Targets are described by intent, not by ephemeral ids. */
export type Step =
  | { kind: "goto"; url: string }
  | { kind: "click"; target: Target }
  | { kind: "type"; target: Target; text: string };

/**
 * How to locate an element without leaking driver-specific handles into a scenario.
 * `text` matches an element's accessible name; `selector` is a CSS fallback.
 */
export interface Target {
  text?: string;
  selector?: string;
}

/** A condition the Critic checks against collected Evidence. Deterministic. */
export type Assertion =
  | { kind: "navigated"; to?: string }
  | { kind: "no-console-errors" }
  | { kind: "no-failed-requests" }
  | { kind: "request-status"; urlIncludes: string; status: number };

/** A planned, replayable unit of work: ordered actions plus what to check. */
export interface Scenario {
  name: string;
  steps: Step[];
  assertions: Assertion[];
}

/** A single observed network request. */
export interface NetworkRequest {
  method: string;
  url: string;
  status: number;
  resourceType?: string;
}

/**
 * Three-layer evidence the Critic judges on — execution, perception, logic.
 * Never "the screen looked right": observable facts at three altitudes.
 */
export interface Evidence {
  /** Execution layer — did the actions take effect. */
  execution: {
    actions: ExecutedAction[];
    navigated: boolean;
    finalUrl?: string;
    blocked: boolean;
  };
  /** Perception layer — what the page looked like. */
  perception: {
    screenshot?: string;
  };
  /** Logic layer — what happened underneath. */
  logic: {
    requests: NetworkRequest[];
    console: ConsoleMessage[];
  };
}

export interface ExecutedAction {
  step: Step;
  ok: boolean;
  error?: string;
}

export interface ConsoleMessage {
  type: string;
  text: string;
}

/** The Critic's ruling on one assertion. */
export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  detail?: string;
}

/** Aggregate ruling for a run. */
export interface Verdict {
  passed: boolean;
  results: AssertionResult[];
}

/** Everything a Reporter needs to emit. */
export interface Result {
  scenario: string;
  context: Context;
  evidence: Evidence;
  verdict: Verdict;
}
