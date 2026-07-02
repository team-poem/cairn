/** Public surface of cairn-engine. */
export * from "./core/types.js";
export * from "./core/ports.js";
export { runHarness } from "./core/pipeline.js";
export type { RunHarnessOptions } from "./core/pipeline.js";
export { BuiltinStepHandler, CustomStepHandler, defaultStepHandlers } from "./core/steps.js";
export { runScenario, needsLlmCritic, applyHeals, applyStepHeals } from "./run.js";
export type { RunScenarioOptions, RunScenarioResult } from "./run.js";
export { LlmStepHealer } from "./core/step-heal.js";

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
export { JsonReporter } from "./adapters/reporters/json.js";
export { FakeDriver } from "./adapters/drivers/fake.js";
export { ChromeDevToolsDriver } from "./adapters/drivers/chrome.js";
export { SelfHealingDriver, parseHealChoice } from "./adapters/drivers/self-heal.js";
export type { Heal, SelfHealOptions } from "./adapters/drivers/self-heal.js";

export { ClaudeCodeLlmClient } from "./adapters/llm/claude-code.js";
export { CodexLlmClient } from "./adapters/llm/codex.js";
export { AnthropicLlmClient } from "./adapters/llm/anthropic.js";
export { OpenAILlmClient } from "./adapters/llm/openai.js";
export { GeminiLlmClient } from "./adapters/llm/gemini.js";
export { createLlmClient } from "./adapters/llm/factory.js";
export type { LlmBackend, LlmFactoryOptions } from "./adapters/llm/factory.js";

export { FileSkillStore, loadSkillFile } from "./adapters/skills/file-store.js";

export { discover, parseDecision } from "./core/discover.js";
export type { DiscoverOptions, Decision } from "./core/discover.js";
export { scoreTarget, scoreScenario, weakTargets } from "./core/freeze.js";
export type { TargetScore, ScoredTarget } from "./core/freeze.js";
