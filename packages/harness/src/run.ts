/**
 * High-level entry point: run/replay a Scenario with sensible defaults (the CLI, a desktop
 * app, or CI all go through here). No LLM is constructed unless an `expect` critic or
 * `heal` needs one, so a plain mechanical replay stays deterministic (invariant #4).
 */
import { runHarness } from "./core/pipeline.js";
import { InlineContextProvider } from "./adapters/context/inline.js";
import { StaticPlanner } from "./adapters/planners/static.js";
import { AssertionCritic } from "./adapters/critics/assertion.js";
import type { CustomChecks } from "./adapters/critics/assertion.js";
import { LlmCritic } from "./adapters/critics/llm.js";
import { ChromeDevToolsDriver } from "./adapters/drivers/chrome.js";
import { SelfHealingDriver } from "./adapters/drivers/self-heal.js";
import { ConsoleReporter } from "./adapters/reporters/console.js";
import { createLlmClient } from "./adapters/llm/factory.js";
import type { ContextProvider, Critic, Driver, LlmClient, Reporter } from "./core/ports.js";
import type { Heal } from "./adapters/drivers/self-heal.js";
import type { Result, Scenario, StepProgress } from "./core/types.js";

export interface RunScenarioOptions {
  driver?: Driver;
  /** Default: LlmCritic if the scenario has `expect`, else AssertionCritic. */
  critic?: Critic;
  context?: ContextProvider;
  reporter?: Reporter;
  llm?: LlmClient;
  /** Wrap the driver so broken steps are repaired by the LLM and retried. */
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
}

export interface RunScenarioResult {
  result: Result;
  /** Substitutions self-heal made (empty unless `heal` was set and a step broke). */
  heals: Heal[];
  /** Scenario rewritten with healed targets, ready to re-freeze. Undefined if no heals. */
  healedScenario?: Scenario;
}

export function needsLlmCritic(scenario: Scenario): boolean {
  return scenario.assertions.some((a) => a.kind === "expect");
}

/** Rewrite a scenario's targets with the names self-heal substituted, for re-freezing. */
export function applyHeals(scenario: Scenario, heals: Heal[]): Scenario {
  if (!heals.length) return scenario;
  const byOriginal = new Map(heals.map((h) => [h.original.text, h.healedText]));
  return {
    ...scenario,
    steps: scenario.steps.map((step) => {
      if ("target" in step && step.target.text) {
        const healed = byOriginal.get(step.target.text);
        if (healed) return { ...step, target: { ...step.target, text: healed } };
      }
      return step;
    }),
  };
}

export async function runScenario(
  scenario: Scenario,
  opts: RunScenarioOptions = {},
): Promise<RunScenarioResult> {
  // Build the LLM lazily and once — only if the critic or heal needs it.
  let llmCache = opts.llm;
  const getLlm = (): LlmClient => (llmCache ??= createLlmClient(opts.model ? { model: opts.model } : {}));

  const critic =
    opts.critic ??
    (needsLlmCritic(scenario) ? new LlmCritic(getLlm(), opts.custom) : new AssertionCritic(opts.custom));

  const baseDriver = opts.driver ?? new ChromeDevToolsDriver();
  let healer: SelfHealingDriver | undefined;
  const driver = opts.heal
    ? (healer = new SelfHealingDriver(baseDriver, getLlm(), { onHeal: opts.onHeal }))
    : baseDriver;

  const result = await runHarness(
    {
      context: opts.context ?? new InlineContextProvider(),
      planner: new StaticPlanner(scenario),
      driver,
      critic,
      reporter: opts.reporter ?? new ConsoleReporter(),
    },
    scenario.name,
    { signal: opts.signal, onStep: opts.onStep, captureScreenshots: opts.screenshots },
  );

  const heals = healer?.heals ?? [];
  return { result, heals, healedScenario: heals.length ? applyHeals(scenario, heals) : undefined };
}
