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
  requestStatus?: { urlIncludes: string; status: number; method?: string };
  /** an element with this accessible name is present (optionally constrained by `role`) */
  text?: string;
  role?: string;
}

/**
 * Locate an element by intent, not a driver handle. A frozen target carries several
 * locators so replay survives UI change without falling back to the LLM:
 * `text` (accessible name) is primary, with `nth` picking among identically-named matches;
 * `role` + `index` (position among same-role elements) is a rename-resilient fallback;
 * `selector` is a CSS escape hatch.
 */
export interface Target {
  text?: string;
  role?: string;
  index?: number;
  /**
   * 0-based position among the elements whose accessible name matches `text` (and `role`, when
   * given) — "the 3rd Accept button" is `{ text: "Accept", role: "button", nth: 2 }`. The readable
   * way to address one of several identically-named elements (list UIs), and heal-friendly: the
   * name survives UI change and the position re-derives. Same 0-based convention as `index`;
   * ignored without `text`.
   */
  nth?: number;
  selector?: string;
}

/** Provenance of a frozen assertion, recorded at freeze (spec/core/trace.md): `user` = merged
 * from the case's own criteria (`SuiteCase.expect`/`assertions`); `derived` = grounded from the
 * observed evidence by `deriveAssertions`. Absent on skills frozen before provenance shipped —
 * a reader surfaces those as "unknown", never guesses (fail-closed, like a missing `caseHash`). */
export interface AssertionMeta {
  origin?: "user" | "derived";
  /** Already satisfied by the starting state (right after the entry goto), so this check can pass
   * without the flow doing anything (#137). Stamped at freeze; when EVERY assertion carries it,
   * replay fails closed — the empty-assertion rule's sibling. */
  vacuous?: true;
  /** Why the check cannot discriminate, when it is not the usual reason. Absent means the starting
   * state already satisfied it; `no-destination` means the freeze had a destination it could not
   * name (every path segment was run-minted), so "the flow navigated somewhere" is all that is
   * left. The verdict says which, instead of reporting a flow that did navigate as one that
   * changed nothing. */
  vacuousBecause?: "no-destination";
}

/**
 * `expect` is the only kind an LLM judges; a scenario with only mechanical kinds replays
 * deterministically (invariant #4).
 */
export type Assertion = AssertionMeta &
  (
  | {
      kind: "navigated";
      to?: string;
      /** Discovery already observed this destination before the last executed step whose request
       * tail contains a successful, non-benign, same-site mutation (#203). Advisory provenance:
       * reaching this URL does not prove post-mutation navigation, nor that navigation is pending.
       * Stamped only on derived assertions; replay judgment is unchanged. Correct on-page saves
       * also carry this marker: it must not become a failure gate without additional evidence. */
      observedBeforeLastMutation?: true;
    }
  | { kind: "no-console-errors" }
  | { kind: "no-failed-requests" }
  /** `method` (optional) scopes the match, so a same-prefix GET can't satisfy a POST check —
   * parity with the step-level `expect.requestStatus`. */
  | { kind: "request-status"; urlIncludes: string; status: number; method?: string }
  | { kind: "expect"; criterion: string }
  /** A product-defined success criterion: the host registers a handler for `name`. */
  | { kind: "custom"; name: string; params?: Record<string, unknown> }
  );

export interface Scenario {
  name: string;
  steps: Step[];
  assertions: Assertion[];
  /** Set by discover when it stopped at the step cap without reaching "done" — the path may be
   * incomplete, so a host can warn before trusting the freeze. Absent on a normal finish. */
  truncated?: boolean;
  /** Set by discover when this freeze wrote a `*` for a segment the run minted, in a `navigated`
   * destination or a step's URL expect. Absent means the file predates the notation, so a `*` in it
   * is a literal path character and is matched as one — a page whose real path contains one keeps
   * the meaning it was frozen with instead of quietly widening under a newer engine. */
  wildcards?: true;
  /** `METHOD url` of a request discover saw the flow fire that no check could be frozen for — its
   * URL has no stable path to check (`POST https://api.shop.co/`, or a run-minted first path
   * segment), so any check written from it would be satisfied by every request to that host.
   * Advisory (spec/core/judgment.md): the remaining assertions can be satisfied without the action
   * ever firing, and the CLI says so at freeze time; replay does not fail on it yet. Absent whenever
   * a proof was frozen. */
  unprovenAction?: string;
}

/** An interactive element the discover loop perceives and acts on. Form state rides along so
 * the LLM can see a checkbox it already ticked or a disabled submit instead of thrashing (#93). */
export interface PageElement {
  role: string;
  name: string;
  checked?: boolean | "mixed";
  disabled?: boolean;
  value?: string;
}

/** Emitted per executed step so a consumer (e.g. a desktop timeline) can render live progress. */
export interface StepProgress {
  index: number;
  step: Step;
  ok: boolean;
  error?: string;
  /** True when the step was not executed because its `expect` already held (pre-check skip, #86). */
  skipped?: boolean;
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
  /** True when the step was not executed because its `expect` already held (idempotency pre-check).
   * Surfaced so a skip is always observable — a wrongly pre-satisfied expect must never hide as a
   * plain ok (#86). */
  skipped?: boolean;
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

/** What one completion cost, reported by a backend that can measure (HTTP APIs report exact
 * token counts; subprocess backends can't and simply never report — absent fields = unknown). */
export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Prompt tokens served from the provider's cache (billed cheaper). */
  cacheReadTokens?: number;
}

/** Aggregated LLM usage for one run. `llmCalls` is exact — counted at the seam regardless of
 * backend; token sums cover only the `measuredCalls` that reported. A clean deterministic
 * replay shows `llmCalls: 0` — the engine's core economics, proven per run. */
export interface RunUsage {
  llmCalls: number;
  measuredCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface Result {
  scenario: string;
  context: Context;
  evidence: Evidence;
  verdict: Verdict;
  usage?: RunUsage;
}
