/**
 * The ports of the cairn engine (invariant #2: add behavior by implementing one of these,
 * never by branching inside a stage). Core depends only on these; `../adapters` implement them.
 */
import type {
  Assertion,
  AssertionResult,
  Context,
  Evidence,
  PageElement,
  Result,
  Scenario,
  SettleOptions,
  Step,
  Target,
  Verdict,
} from "./types.js";

/** Grounding from any source (NL, git diff, ticket, RAG). */
export interface ContextProvider {
  provide(task: string): Promise<Context>;
}

/** Intent → ordered Scenario. Frozen-replay planning uses no LLM (invariant #4); discovery is a separate LLM planner. */
export interface Planner {
  plan(ctx: Context): Promise<Scenario>;
}

/** Drives a browser. Replaceable without touching core (invariant #5); resolves targets from intent, not handles. */
export interface Driver {
  goto(url: string): Promise<void>;
  click(target: Target): Promise<void>;
  doubleClick(target: Target): Promise<void>;
  hover(target: Target): Promise<void>;
  type(target: Target, text: string): Promise<void>;
  /** Resolve a target and return it enriched with resilient locators (role, structural index) for freezing. */
  locate(target: Target): Promise<Target>;
  /** Choose an option in a `<select>` dropdown. */
  select(target: Target, value: string): Promise<void>;
  /** Press a key or combo (e.g. "Enter", "Escape", "Control+a"). */
  pressKey(key: string): Promise<void>;
  /** Scroll the page to reveal lazy/below-the-fold content. */
  scroll(direction?: "down" | "up"): Promise<void>;
  /** Capture the current page as a data URL (for visual replay); undefined if unavailable. */
  screenshot(): Promise<string | undefined>;
  snapshot(): Promise<PageElement[]>;
  /** Execute-stage auto-wait for network idle (design §3). Best-effort, time-bounded, never throws. */
  settle(options?: SettleOptions): Promise<void>;
  observe(): Promise<Evidence>;
  close(): Promise<void>;
}

/** A product-defined interaction for a `{ kind: "custom", name }` step — composes the Driver. */
export type CustomAction = (driver: Driver, params: Record<string, unknown>) => Promise<void>;

/**
 * One link in the Execute stage's dispatch chain (invariant #2): the pipeline routes each Step
 * to the first handler that `supports` it, instead of branching inside the stage. Built-in kinds
 * and product `custom` actions resolve through this one seam (Spring `HandlerAdapter`-style).
 */
export interface StepHandler {
  supports(step: Step): boolean;
  execute(step: Step, driver: Driver): Promise<void>;
}

export interface SkillStore {
  resolve(name: string): Promise<Scenario | undefined>;
}

/**
 * One link in the Judge stage's dispatch chain (mirror of StepHandler): a Critic routes each
 * Assertion to the first handler that `supports` it. Mechanical, product `custom`, and LLM
 * `expect` checks compose as separate handlers — critics differ only by which they register.
 * Optional `ctx` grounds LLM judgment (e.g. the task intent); deterministic handlers ignore it.
 */
export interface AssertionHandler {
  supports(assertion: Assertion): boolean;
  judge(
    assertion: Assertion,
    evidence: Evidence,
    ctx?: Context,
  ): AssertionResult | Promise<AssertionResult>;
}

/** Judges evidence against assertions (mechanical, baseline, or LLM). Optional `ctx` grounds LLM judgment (e.g. the task intent); deterministic critics ignore it, so replay stays deterministic (invariant #4). */
export interface Critic {
  judge(evidence: Evidence, assertions: Assertion[], ctx?: Context): Promise<Verdict>;
}

/** Emits a result anywhere — console, json, an arbitrary tracker. */
export interface Reporter {
  emit(result: Result): Promise<void>;
}

export interface Harness {
  context: ContextProvider;
  planner: Planner;
  driver: Driver;
  critic: Critic;
  reporter: Reporter;
  skills?: SkillStore;
}

/** Model-agnostic LLM seam (invariant #5); `createLlmClient` picks the implementation. */
export interface LlmClient {
  readonly id: string;
  complete(prompt: string, opts?: CompleteOptions): Promise<string>;
}

export interface CompleteOptions {
  system?: string;
  maxTokens?: number;
}
