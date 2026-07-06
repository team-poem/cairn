/**
 * High-level entry point: run/replay a Scenario with sensible defaults (the CLI, a desktop
 * app, or CI all go through here). No LLM is constructed unless an `expect` critic or
 * `heal` needs one, so a plain mechanical replay stays deterministic (invariant #4).
 */
import { runHarness } from "./core/pipeline.js";
import { discover } from "./core/discover/index.js";
import type { CustomAction } from "./core/ports.js";
import { InlineContextProvider } from "./adapters/context/inline.js";
import { StaticPlanner } from "./adapters/planners/static.js";
import { AssertionCritic } from "./adapters/critics/assertion.js";
import type { CustomChecks } from "./adapters/critics/assertion.js";
import { LlmCritic } from "./adapters/critics/llm.js";
import { ChromeDevToolsDriver } from "./adapters/drivers/chrome.js";
import { SelfHealingDriver } from "./adapters/drivers/self-heal.js";
import { ConsoleReporter } from "./adapters/reporters/console.js";
import { createLlmClient } from "./adapters/llm/factory.js";
import { LlmStepHealer } from "./core/step-heal.js";
import { UsageMeter, emptyUsage } from "./core/usage.js";
import type { ActionPolicy } from "./core/discover/index.js";
import type { ContextProvider, Critic, Driver, LlmClient, Reporter, StepHeal } from "./core/ports.js";
import type { Heal } from "./adapters/drivers/self-heal.js";
import type { Result, RunUsage, Scenario, StepProgress } from "./core/types.js";

export interface RunScenarioOptions {
  driver?: Driver;
  /** Default: LlmCritic if the scenario has `expect`, else AssertionCritic. */
  critic?: Critic;
  context?: ContextProvider;
  reporter?: Reporter;
  llm?: LlmClient;
  /**
   * Repair broken replays with the LLM (invariant #4 sanctioned use). Two layers, both only when set:
   * a `SelfHealingDriver` fixes a step whose target no longer resolves, and — if the run still fails
   * its assertions (a "passed-the-steps-but-wrong-outcome" break that locator-heal can't catch) —
   * the scenario is re-discovered from the start. A green replay triggers neither (stays LLM-free).
   */
  heal?: boolean;
  /** Fired on each self-heal — a host's signal that the frozen scenario is aging. */
  onHeal?: (heal: Heal) => void;
  model?: string;
  /** Abort the run between steps (a host's Stop button). */
  signal?: AbortSignal;
  /** Per-step progress, for a live timeline. */
  onStep?: (progress: StepProgress) => void;
  /** Capture a screenshot after each step (attached to onStep / a host's visual replay). */
  screenshots?: boolean;
  /** Product-defined checks for `{ kind: "custom", name }` assertions — the host defines success. */
  custom?: CustomChecks;
  /** URL substrings whose 4xx/5xx is product noise (e.g. analytics), excluded from `no-failed-requests`. */
  benign?: string[];
  /** Console-text substrings that are product noise (e.g. i18n warnings), excluded from `no-console-errors`. */
  benignConsole?: string[];
  /** First-path-segment prefixes URL matching may strip as locales (fallback only, #86); default is
   * a small conservative built-in list. Applies to both step `expect` matching and the `navigated`
   * verdict, so a run's replay checks and its final assertion agree on the same URL. `[]` disables. */
  localePrefixes?: readonly string[];
  /** Product-defined handlers for `{ kind: "custom", name }` steps — the host defines interactions. */
  actions?: Record<string, CustomAction>;
  /** How long a step's `expect` is polled (readiness) before it counts as diverged. Default 2000ms. */
  expectTimeoutMs?: number;
  /** Gate for the outcome-heal re-discovery — the same ActionPolicy `discover()` takes, so an
   * unattended repair can't run actions the authoring policy would have blocked (#76). */
  policy?: ActionPolicy;
}

export interface RunScenarioResult {
  result: Result;
  /** Locator substitutions self-heal made (empty unless `heal` was set and a target broke). */
  heals: Heal[];
  /** Surgical step repairs (empty unless `heal` was set and a step's `expect` diverged). */
  stepHeals: StepHeal[];
  /** Scenario rewritten with healed targets/steps, ready to re-freeze. Undefined if no heals. */
  healedScenario?: Scenario;
}

export function needsLlmCritic(scenario: Scenario): boolean {
  return scenario.assertions.some((a) => a.kind === "expect");
}

/** The scenario's entry URL (its first `goto`), so an outcome-heal re-discovers from the same start. */
function firstGotoUrl(scenario: Scenario): string | undefined {
  const first = scenario.steps[0];
  return first && first.kind === "goto" ? first.url : undefined;
}

/** Rewrite a scenario's targets with the (re-located) targets self-heal substituted, for re-freezing.
 * Keyed by the original target's object identity — which flows unchanged from the step through the
 * driver into the Heal — so two steps sharing a label don't rewrite together (#39). */
export function applyHeals(scenario: Scenario, heals: Heal[]): Scenario {
  if (!heals.length) return scenario;
  const byOriginal = new Map(heals.map((h) => [h.original, h.healed]));
  return {
    ...scenario,
    steps: scenario.steps.map((step) => {
      if ("target" in step) {
        const healed = byOriginal.get(step.target);
        if (healed) return { ...step, target: healed };
      }
      return step;
    }),
  };
}

/** Replace surgically-healed steps in place (keyed by index, so same-label steps don't collide). */
export function applyStepHeals(scenario: Scenario, heals: StepHeal[]): Scenario {
  if (!heals.length) return scenario;
  const byIndex = new Map(heals.map((h) => [h.index, h.step]));
  return { ...scenario, steps: scenario.steps.map((step, i) => byIndex.get(i) ?? step) };
}

export async function runScenario(
  scenario: Scenario,
  opts: RunScenarioOptions = {},
): Promise<RunScenarioResult> {
  // Build the LLM lazily and once — only if the critic or heal needs it. The meter wraps
  // whichever client is used (host-injected included), so `result.usage` counts every call;
  // a run that never constructs the LLM reports llmCalls: 0 — the deterministic-replay proof.
  let meter: UsageMeter | undefined;
  const getLlm = (): LlmClient =>
    (meter ??= new UsageMeter(opts.llm ?? createLlmClient(opts.model ? { model: opts.model } : {})));
  const usage = (): RunUsage => meter?.snapshot() ?? emptyUsage();

  const critic =
    opts.critic ??
    (needsLlmCritic(scenario)
      ? new LlmCritic(getLlm(), opts.custom, opts.benign, opts.benignConsole, opts.localePrefixes)
      : new AssertionCritic(opts.custom, opts.benign, opts.benignConsole, opts.localePrefixes));

  // Lifecycle ownership (#98): the engine closes only the driver it constructed here. A
  // caller-supplied driver is the caller's to close — a host may run many scenarios on one session.
  const baseDriver = opts.driver ?? new ChromeDevToolsDriver();
  const ownsDriver = !opts.driver;
  let healer: SelfHealingDriver | undefined;
  const driver = opts.heal
    ? (healer = new SelfHealingDriver(baseDriver, getLlm(), { onHeal: opts.onHeal }))
    : baseDriver;
  const stepHealer = opts.heal ? new LlmStepHealer(getLlm()) : undefined;

  try {
    const result = await runHarness(
      {
        context: opts.context ?? new InlineContextProvider(),
        planner: new StaticPlanner(scenario),
        driver,
        critic,
        reporter: opts.reporter ?? new ConsoleReporter(),
      },
      scenario.name,
      {
        signal: opts.signal,
        onStep: opts.onStep,
        captureScreenshots: opts.screenshots,
        actions: opts.actions,
        stepHealer,
        expectTimeoutMs: opts.expectTimeoutMs,
        localePrefixes: opts.localePrefixes,
        usage,
      },
    );

    const heals = healer?.heals ?? [];
    const stepHeals = stepHealer?.heals ?? [];

    // Outcome-aware heal: the steps ran (locators/steps may even have healed) but the run still failed
    // its assertions — the frozen path no longer reaches the goal, a break surgical-heal couldn't fix.
    // Re-discover from the start (invariant #4 sanctioned use (b)); only on failure. Runs on the SAME
    // live session (no close/reopen), so app state (auth, storage) matches replay conditions.
    if (opts.heal && !result.verdict.passed) {
      // #78: watermark the cumulative logs so the verdict sees only the re-discovery's own evidence —
      // the failed run's requests must not satisfy a request-status.
      const before = await baseDriver.observe();
      const sinceRequest = before.logic.requests.length;
      const sinceConsole = before.logic.console.length;

      const repaired = await discover(scenario.name, {
        driver: baseDriver,
        llm: getLlm(),
        baseUrl: firstGotoUrl(scenario),
        signal: opts.signal,
        policy: opts.policy,
      });
      const ctx = await (opts.context ?? new InlineContextProvider()).provide(scenario.name);
      const observed = await baseDriver.observe();
      const evidence = {
        ...observed,
        logic: {
          requests: observed.logic.requests.slice(sinceRequest),
          console: observed.logic.console.slice(sinceConsole),
        },
      };
      // Judge against the ORIGINAL goal assertions, not the ones the re-discovery derived for itself —
      // else a path that reaches a different end-state passes as green (P2 false green).
      const verdict = await critic.judge(evidence, scenario.assertions, ctx);
      return {
        result: { scenario: repaired.name, context: ctx, evidence, verdict, usage: usage() },
        heals,
        stepHeals,
        healedScenario: { ...repaired, assertions: scenario.assertions },
      };
    }

    const rewritten = applyStepHeals(applyHeals(scenario, heals), stepHeals);
    return {
      result,
      heals,
      stepHeals,
      healedScenario: heals.length || stepHeals.length ? rewritten : undefined,
    };
  } finally {
    if (ownsDriver) await baseDriver.close().catch(() => {});
  }
}
