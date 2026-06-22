/**
 * The six extension points of the cairn pipeline (invariant #2: new behavior is added
 * by implementing one of these, never by branching inside a pipeline stage).
 *
 *   ContextProvider · Planner · Driver · SkillStore · Critic · Reporter
 *
 * The core ships default implementations; an environment plugs in by implementing
 * an interface and passing it to `runHarness`.
 */
import type {
  Assertion,
  Context,
  Evidence,
  Result,
  Scenario,
  Step,
  Target,
  Verdict,
} from "./types.js";

/** Assembles grounding for a task from any source (NL, git diff, ticket, RAG). */
export interface ContextProvider {
  provide(task: string): Promise<Context>;
}

/**
 * Turns intent into an ordered Scenario.
 *
 * The replay path must stay deterministic (invariant #4): a Planner that resolves a
 * frozen/explicit scenario uses no LLM. An exploratory Planner that calls an LLM is a
 * separate implementation, used only for discovering a *new* scenario.
 */
export interface Planner {
  plan(ctx: Context): Promise<Scenario>;
}

/**
 * Drives a browser. Default impl is Chrome DevTools MCP; replaceable (e.g. Playwright)
 * without touching the core (invariant #5). Targets are resolved by the driver from
 * intent (text/selector) so scenarios never carry driver-specific element handles.
 */
export interface Driver {
  goto(url: string): Promise<void>;
  click(target: Target): Promise<void>;
  type(target: Target, text: string): Promise<void>;
  /** Collect a fresh three-layer evidence snapshot of current state. */
  observe(): Promise<Evidence>;
  close(): Promise<void>;
}

/** A reusable, named flow that can be frozen and replayed deterministically. */
export interface Skill {
  name: string;
  scenario: Scenario;
}

/** Resolves named skills (freeze / replay). */
export interface SkillStore {
  resolve(name: string): Promise<Skill | undefined>;
}

/** Judges evidence against assertions. May be assertions, baseline diff, or LLM. */
export interface Critic {
  judge(evidence: Evidence, assertions: Assertion[]): Promise<Verdict>;
}

/** Emits a result anywhere — console, json file, an arbitrary tracker. */
export interface Reporter {
  emit(result: Result): Promise<void>;
}

/** The dependency set the pipeline orchestrates over. */
export interface Harness {
  context: ContextProvider;
  planner: Planner;
  driver: Driver;
  critic: Critic;
  reporter: Reporter;
  skills?: SkillStore;
}

/** Convenience handle so a Driver can announce the action it just executed. */
export type ActionStep = Step;
