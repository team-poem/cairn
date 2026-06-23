/** Domain types for the pipeline (Context → Plan → Execute → Judge → Report). App-agnostic by invariant #1. */

export interface Context {
  intent: string;
  baseUrl?: string;
  notes?: string[];
}

export type Step =
  | { kind: "goto"; url: string }
  | { kind: "click"; target: Target }
  | { kind: "doubleClick"; target: Target }
  | { kind: "hover"; target: Target }
  | { kind: "type"; target: Target; text: string }
  | { kind: "select"; target: Target; value: string }
  | { kind: "pressKey"; key: string }
  | { kind: "scroll"; direction?: "down" | "up" };

/** Locate an element by intent, not a driver handle: `text` = accessible name, `selector` = CSS fallback. */
export interface Target {
  text?: string;
  selector?: string;
}

/**
 * `expect` is the only kind an LLM judges; a scenario with only mechanical kinds replays
 * deterministically (invariant #4).
 */
export type Assertion =
  | { kind: "navigated"; to?: string }
  | { kind: "no-console-errors" }
  | { kind: "no-failed-requests" }
  | { kind: "request-status"; urlIncludes: string; status: number }
  | { kind: "expect"; criterion: string };

export interface Scenario {
  name: string;
  steps: Step[];
  assertions: Assertion[];
}

/** An interactive element the discover loop perceives and acts on. */
export interface PageElement {
  role: string;
  name: string;
}

/** Emitted per executed step so a consumer (e.g. a desktop timeline) can render live progress. */
export interface StepProgress {
  index: number;
  step: Step;
  ok: boolean;
  error?: string;
  /** A screenshot data URL, present only when screenshot capture is enabled. */
  screenshot?: string;
}

export interface SettleOptions {
  idleMs?: number;
  timeoutMs?: number;
  pollMs?: number;
}

export interface NetworkRequest {
  method: string;
  url: string;
  status: number;
  resourceType?: string;
}

/** Three observable layers the Critic judges on — never "the screen looked right". */
export interface Evidence {
  execution: {
    actions: ExecutedAction[];
    navigated: boolean;
    finalUrl?: string;
    blocked: boolean;
  };
  perception: {
    screenshot?: string;
  };
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

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  detail?: string;
}

export interface Verdict {
  passed: boolean;
  results: AssertionResult[];
}

export interface Result {
  scenario: string;
  context: Context;
  evidence: Evidence;
  verdict: Verdict;
}
