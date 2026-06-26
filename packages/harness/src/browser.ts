/**
 * Browser-safe surface of cairn-engine — the runtime-agnostic core plus the pure adapters,
 * for environments without Node (a Chrome extension, a web app). Excludes the Node-only
 * adapters (Chrome DevTools MCP driver, Claude CLI client, fs-based reporters / skill store)
 * and `runScenario`, which statically wires them.
 *
 * Compose `runHarness` with your own `Driver` (e.g. a CDP/extension driver) and, for discover or
 * `expect`, a fetch-based `LlmClient` (`AnthropicLlmClient`). Same core, different hands.
 */
export * from "./core/types.js";
export * from "./core/ports.js";
export { runHarness } from "./core/pipeline.js";
export type { RunHarnessOptions } from "./core/pipeline.js";
export { BuiltinStepHandler, CustomStepHandler, defaultStepHandlers } from "./core/steps.js";

export { InlineContextProvider } from "./adapters/context/inline.js";
export { StaticPlanner } from "./adapters/planners/static.js";
export {
  AssertionCritic,
  checkAssertion,
  resolveAssertion,
  judgeAssertion,
  MechanicalAssertionHandler,
  CustomAssertionHandler,
} from "./adapters/critics/assertion.js";
export type { CustomCheck, CustomChecks } from "./adapters/critics/assertion.js";
export { LlmCritic, ExpectAssertionHandler, summarizeEvidence } from "./adapters/critics/llm.js";
export { ConsoleReporter } from "./adapters/reporters/console.js";
export { FakeDriver } from "./adapters/drivers/fake.js";
export { SelfHealingDriver, parseHealChoice } from "./adapters/drivers/self-heal.js";
export type { Heal, SelfHealOptions } from "./adapters/drivers/self-heal.js";

export { AnthropicLlmClient } from "./adapters/llm/anthropic.js";

export { discover, parseDecision } from "./core/discover.js";
export type { DiscoverOptions, Decision } from "./core/discover.js";
export { LlmStepHealer } from "./core/step-heal.js";
export { scoreTarget, scoreScenario, weakTargets } from "./core/freeze.js";
export type { TargetScore, ScoredTarget } from "./core/freeze.js";
