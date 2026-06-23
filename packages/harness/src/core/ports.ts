/**
 * The ports of the cairn engine (invariant #2: add behavior by implementing one of these,
 * never by branching inside a stage). Core depends only on these; `../adapters` implement them.
 */
import type {
  Assertion,
  Context,
  Evidence,
  PageElement,
  Result,
  Scenario,
  SettleOptions,
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
  /** Choose an option in a `<select>` dropdown. */
  select(target: Target, value: string): Promise<void>;
  /** Press a key or combo (e.g. "Enter", "Escape", "Control+a"). */
  pressKey(key: string): Promise<void>;
  /** Scroll the page to reveal lazy/below-the-fold content. */
  scroll(direction?: "down" | "up"): Promise<void>;
  snapshot(): Promise<PageElement[]>;
  /** Execute-stage auto-wait for network idle (design §3). Best-effort, time-bounded, never throws. */
  settle(options?: SettleOptions): Promise<void>;
  observe(): Promise<Evidence>;
  close(): Promise<void>;
}

export interface Skill {
  name: string;
  scenario: Scenario;
}

export interface SkillStore {
  resolve(name: string): Promise<Skill | undefined>;
}

/** Judges evidence against assertions (mechanical, baseline, or LLM). */
export interface Critic {
  judge(evidence: Evidence, assertions: Assertion[]): Promise<Verdict>;
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
