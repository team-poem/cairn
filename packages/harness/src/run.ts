/**
 * High-level entry point: run (or replay) a Scenario with sensible defaults.
 *
 * This is the API a consumer calls instead of wiring the pipeline by hand — the CLI, a
 * desktop app, or a CI job all go through here. Everything is still an injectable
 * interface (invariant #2); the defaults just cover the common case:
 *   - deterministic critic, unless the scenario has natural-language `expect` criteria
 *   - optional self-heal that records substitutions and returns a re-frozen scenario
 *   - Chrome DevTools driver, model-agnostic LLM behind the seam (invariant #5)
 *
 * No LLM is constructed unless something actually needs one (an `expect` critic or
 * `heal`), so a plain mechanical replay stays deterministic and LLM-free (invariant #4).
 */
import { runHarness } from "./core/pipeline.js";
import { InlineContextProvider } from "./adapters/context/inline.js";
import { StaticPlanner } from "./adapters/planners/static.js";
import { AssertionCritic } from "./adapters/critics/assertion.js";
import { LlmCritic } from "./adapters/critics/llm.js";
import { ChromeDevToolsDriver } from "./adapters/drivers/chrome.js";
import { SelfHealingDriver } from "./adapters/drivers/self-heal.js";
import { ConsoleReporter } from "./adapters/reporters/console.js";
import { createLlmClient } from "./adapters/llm/factory.js";
import type { ContextProvider, Critic, Driver, Reporter } from "./core/ports.js";
import type { Heal } from "./adapters/drivers/self-heal.js";
import type { LlmClient } from "./core/ports.js";
import type { Result, Scenario } from "./core/types.js";

export interface RunScenarioOptions {
  /** Browser driver. Default: a fresh ChromeDevToolsDriver. */
  driver?: Driver;
  /** Critic. Default: LlmCritic if the scenario has `expect`, else AssertionCritic. */
  critic?: Critic;
  /** Context provider. Default: InlineContextProvider. */
  context?: ContextProvider;
  /** Where results go. Default: ConsoleReporter. */
  reporter?: Reporter;
  /** LLM backend for the auto critic / self-heal. Default: createLlmClient(). */
  llm?: LlmClient;
  /** Wrap the driver so broken steps are repaired by the LLM and retried. */
  heal?: boolean;
  /** Model alias passed to the default LLM factory (e.g. "haiku"). */
  model?: string;
}

export interface RunScenarioResult {
  result: Result;
  /** Substitutions self-heal made (empty unless `heal` was set and a step broke). */
  heals: Heal[];
  /** The scenario rewritten with healed targets, ready to re-freeze. Undefined if no heals. */
  healedScenario?: Scenario;
}

/** Does this scenario need an LLM critic? (any natural-language `expect` criterion) */
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
      if ((step.kind === "click" || step.kind === "type") && step.target.text) {
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
  // Construct the LLM lazily and once — only if the critic or heal actually needs it.
  let llmCache = opts.llm;
  const getLlm = (): LlmClient => (llmCache ??= createLlmClient(opts.model ? { model: opts.model } : {}));

  const critic = opts.critic ?? (needsLlmCritic(scenario) ? new LlmCritic(getLlm()) : new AssertionCritic());

  const baseDriver = opts.driver ?? new ChromeDevToolsDriver();
  let healer: SelfHealingDriver | undefined;
  const driver = opts.heal ? (healer = new SelfHealingDriver(baseDriver, getLlm())) : baseDriver;

  const result = await runHarness(
    {
      context: opts.context ?? new InlineContextProvider(),
      planner: new StaticPlanner(scenario),
      driver,
      critic,
      reporter: opts.reporter ?? new ConsoleReporter(),
    },
    scenario.name,
  );

  const heals = healer?.heals ?? [];
  return { result, heals, healedScenario: heals.length ? applyHeals(scenario, heals) : undefined };
}
