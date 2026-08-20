/**
 * The ports of the cairn engine (invariant #2: add behavior by implementing one of these,
 * never by branching inside a stage). Core depends only on these; `../adapters` implement them.
 */
import type {
  Assertion,
  AssertionResult,
  Context,
  Evidence,
  LlmUsage,
  PageElement,
  Result,
  Scenario,
  SettleOptions,
  Step,
  Target,
  Verdict,
} from "./types.js";
import type { TraceEvent } from "./trace.js";

/** Grounding from any source (NL, git diff, ticket, RAG). */
export interface ContextProvider {
  provide(task: string): Promise<Context>;
}

/**
 * Intent → ordered Scenario for the plan-then-execute pipeline (frozen replay uses no LLM, invariant #4).
 * Discovery is NOT a Planner: `discover()` is a separate free function that interleaves observe→act→adapt
 * against the live browser (invariant #3), so it can't be a pure `plan(ctx)`. The CLI's `discover` calls
 * it directly, outside the Harness/Planner pipeline.
 */
export interface Planner {
  plan(ctx: Context): Promise<Scenario>;
}

/** Drives a browser. Replaceable without touching core (invariant #5); resolves targets from intent, not handles.
 *
 * Lifecycle: whoever constructs a Driver owns it — the engine closes only drivers it created
 * (`runScenario`'s default); a caller-supplied driver is closed by the caller. `close()` ends the
 * session permanently: a closed driver must not be reused — construct a new instance instead (#98).
 *
 * Trusted input: interaction methods (`click`/`type`/`select`/…) must dispatch *trusted*,
 * user-level events (CDP input, real key/mouse), never a synthetic JS `.click()` — a controlled
 * component ignores untrusted events, so a shortcut would silently no-op. The reference driver
 * (Chrome DevTools MCP) satisfies this; a custom driver must too.
 *
 * Perception is a11y-native: `snapshot()` reports what the accessibility tree exposes — cairn
 * perceives like assistive tech, so a control whose state lives outside a11y (a custom widget with
 * no `aria-checked`/role/name — an accessibility violation) is *invisible or mis-reported to cairn
 * exactly as it is to a screen reader*. The engine does not special-case app-specific DOM to work
 * around this (invariant #1). A consumer whose app has such widgets injects corrected perception by
 * wrapping `snapshot()` in its own Driver — the sanctioned seam — while the real fix is the app
 * exposing proper ARIA state. */
export interface Driver {
  goto(url: string): Promise<void>;
  click(target: Target): Promise<void>;
  doubleClick(target: Target): Promise<void>;
  hover(target: Target): Promise<void>;
  type(target: Target, text: string): Promise<void>;
  /** Resolve a target and return it enriched with resilient locators (role, structural index) for freezing. */
  locate(target: Target): Promise<Target>;
  /** Choose an option in a dropdown by its value — native `<select>` or a custom ARIA
   * combobox/listbox/option, resolved by the driver. */
  select(target: Target, value: string): Promise<void>;
  /** Press a key or combo (e.g. "Enter", "Escape", "Control+a"). */
  pressKey(key: string): Promise<void>;
  /** Scroll the page to reveal lazy/below-the-fold content. */
  scroll(direction?: "down" | "up"): Promise<void>;
  /** Capture the current page as a data URL (for visual replay); undefined if unavailable. */
  screenshot(): Promise<string | undefined>;
  snapshot(): Promise<PageElement[]>;
  /** Auto-wait for the app to quiesce after an action (network idle + any render/JS beat a driver can
   * observe). Best-effort, time-bounded, never throws. It is a *heuristic*, not a guarantee — a step's
   * real readiness is gated deterministically by its `expect` (polled at replay, invariant #4) or an
   * explicit `waitFor`; `settle` just reduces the race, it doesn't replace them (design §3). */
  settle(options?: SettleOptions): Promise<void>;
  observe(): Promise<Evidence>;
  close(): Promise<void>;
}

/** A product-defined interaction for a `{ kind: "custom", name }` step — composes the Driver. */
export type CustomAction = (driver: Driver, params: Record<string, unknown>) => Promise<void>;

/** Correct the perceived state of controls a page exposes OUTSIDE the a11y tree (a custom checkbox
 * whose visual state lives in a styled class, not `aria-checked`). Runs on each snapshot before the
 * elements reach the model, returning them with corrected state. The engine stays a11y-native and
 * app-agnostic (invariant #1) — it offers the seam; the consumer supplies the app-specific reading. */
export type PerceptionAdapter = (elements: PageElement[]) => PageElement[] | Promise<PageElement[]>;

/**
 * One link in the Execute stage's dispatch chain (invariant #2): the pipeline routes each Step
 * to the first handler that `supports` it, instead of branching inside the stage. Built-in kinds
 * and product `custom` actions resolve through this one seam (Spring `HandlerAdapter`-style).
 */
export interface StepHandler {
  supports(step: Step): boolean;
  execute(step: Step, driver: Driver): Promise<void>;
}

/** Repairs a step whose `expect` failed at replay — surgically, from the step's `intent`, not by
 * re-discovering the whole scenario. The LLM lives here (sanctioned, invariant #4(b)); injected only
 * when healing is asked, so clean replay stays LLM-free. Returns the corrective step, or null. */
export interface StepHealer {
  heal(step: Step, index: number, driver: Driver): Promise<StepHeal | null>;
}

export interface StepHeal {
  index: number;
  step: Step;
}

/**
 * Persists frozen scenarios. `ref` is a store-defined reference — a file path for the built-in
 * `FileSkillStore`; an S3 key, DB id, or registry name for another store. `load` throws when the
 * reference is missing or the artifact isn't a bare Scenario; `freeze` returns the canonical
 * reference it wrote. The CLI's load/replay/freeze paths all route through this port
 * (invariant #2) — the frozen skill itself stays plain data either way (pattern ≠ data).
 */
export interface SkillStore {
  load(ref: string): Promise<Scenario>;
  freeze(ref: string, scenario: Scenario): Promise<string>;
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

/** Bytes for an attachment a `step` event refers to by `id` (spec/core/trace.md §Attachments).
 * `data` is a data URL, as `Driver.screenshot()` returns it — each serialization decides what to
 * do with it (a stored trace writes a sidecar; a live stream may forward the URL as-is). */
export interface TraceAttachment {
  /** Seq-derived, assigned by the Tracer — the same string the step event carries. */
  id: string;
  /** `data:<mediaType>;base64,<payload>`. */
  data: string;
}

/** Receives the lifecycle event stream (spec/core/trace.md). Sync fire-and-forget: the engine
 * calls it inline and swallows throws — an implementation that does IO buffers internally.
 * Absent → no events are built at all (zero cost), and behavior is unchanged. */
export interface TraceSink {
  emit(event: TraceEvent): void;
  /** Optional. A sink that implements it gets attachment bytes and its step events carry
   * `attachment` ids; a sink that doesn't never causes them to be captured at all (zero cost —
   * same stance as an absent sink). Called before the event that references the id. */
  attach?(attachment: TraceAttachment): void;
}

export interface Harness {
  context: ContextProvider;
  planner: Planner;
  driver: Driver;
  critic: Critic;
  reporter: Reporter;
}

/** Model-agnostic LLM seam (invariant #5); `createLlmClient` picks the implementation. */
export interface LlmClient {
  readonly id: string;
  complete(prompt: string, opts?: CompleteOptions): Promise<string>;
}

export interface CompleteOptions {
  system?: string;
  maxTokens?: number;
  /** Report what this completion cost, when the backend can measure it (HTTP APIs). Call at most
   * once per completion; a backend that can't measure (subprocess CLIs) just never calls it —
   * measurement is owned by the seam, never fabricated by the engine. */
  onUsage?: (usage: LlmUsage) => void;
}
