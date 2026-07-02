/** Domain types for the pipeline (Context → Plan → Execute → Judge → Report). App-agnostic by invariant #1. */

export interface Context {
  intent: string;
}

/** Per-step surgical-heal metadata: `intent` is what a heal re-decides from; `expect` is a
 * post-condition replay verifies deterministically (same shape as `waitFor`). See spec/core/surgical-heal.md. */
export interface StepMeta {
  intent?: string;
  expect?: WaitUntil;
}

export type Step = StepMeta &
  (
    | { kind: "goto"; url: string }
    | { kind: "click"; target: Target }
    | { kind: "doubleClick"; target: Target }
    | { kind: "hover"; target: Target }
    | { kind: "type"; target: Target; text: string }
    | { kind: "select"; target: Target; value: string }
    | { kind: "pressKey"; key: string }
    | { kind: "scroll"; direction?: "down" | "up" }
    /** Block until the app reaches a condition (auth ready, a request, an element) before continuing.
     * Deterministic — polls the Driver's own observation, no LLM (invariant #4). */
    | { kind: "waitFor"; until: WaitUntil; timeoutMs?: number }
    /** A product-defined interaction: the host registers a handler for `name`. */
    | { kind: "custom"; name: string; params?: Record<string, unknown> }
  );

/**
 * A condition a `waitFor` step blocks on. All provided fields must hold (AND). Checked against the
 * Driver's `observe()`/`snapshot()` — so any Driver supports it without a new port method.
 */
export interface WaitUntil {
  /** the final URL includes this substring */
  url?: string;
  /** a captured request whose URL includes `urlIncludes` reached `status` */
  requestStatus?: { urlIncludes: string; status: number };
  /** an element with this accessible name is present (optionally constrained by `role`) */
  text?: string;
  role?: string;
}

/**
 * Locate an element by intent, not a driver handle. A frozen target carries several
 * locators so replay survives UI change without falling back to the LLM:
 * `text` (accessible name) is primary; `role` + `index` (position among same-role elements)
 * is a rename-resilient fallback; `selector` is a CSS escape hatch.
 */
export interface Target {
  text?: string;
  role?: string;
  index?: number;
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
  | { kind: "expect"; criterion: string }
  /** A product-defined success criterion: the host registers a handler for `name`. */
  | { kind: "custom"; name: string; params?: Record<string, unknown> };

export interface Scenario {
  name: string;
  steps: Step[];
  assertions: Assertion[];
  /** Set by discover when it stopped at the step cap without reaching "done" — the path may be
   * incomplete, so a host can warn before trusting the freeze. Absent on a normal finish. */
  truncated?: boolean;
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

/** Three observable layers. Execution + logic drive the deterministic verdict (never "the screen
 * looked right"); perception (screenshots) feeds the host's visual replay and is available to custom
 * checks — built-in critics don't judge it yet (LLM-vision assertions are future). */
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
  /** Set when the verdict didn't come from the results alone — e.g. failing closed on an empty assertion set. */
  detail?: string;
}

export interface Result {
  scenario: string;
  context: Context;
  evidence: Evidence;
  verdict: Verdict;
}
