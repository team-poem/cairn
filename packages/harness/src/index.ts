/** Public surface of cairn-engine. */
export * from "./core/types.js";
export * from "./core/ports.js";
export { runHarness } from "./core/pipeline.js";
export type { RunHarnessOptions } from "./core/pipeline.js";
export { BuiltinStepHandler, CustomStepHandler, defaultStepHandlers, DEFAULT_LOCALE_PREFIXES } from "./core/steps.js";
export type { UrlMatchOptions } from "./core/steps.js";
export { runScenario, needsLlmCritic, applyHeals, applyStepHeals } from "./run.js";
export type { RunScenarioOptions, RunScenarioResult } from "./run.js";
export { runSuite } from "./suite.js";
export type { SuiteCase, SuiteOptions, SuiteResult, SuiteVerdict } from "./suite.js";
export { TRACE_VERSION, Tracer, TraceScope, assertionPayload, startTrace } from "./core/trace.js";
export { ENGINE_VERSION } from "./version.js";
export type { TraceEmission, TraceEvent, TracePhase } from "./core/trace.js";
export { renderSuiteReport } from "./adapters/reporters/suite.js";
export { LlmStepHealer } from "./core/step-heal.js";

export { InlineContextProvider } from "./adapters/context/inline.js";
export { StaticPlanner } from "./adapters/planners/static.js";
export {
  AssertionCritic,
  checkAssertion,
  resolveAssertion,
  judgeAssertion,
  toVerdict,
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

export { FileSkillStore, loadSkillFile, saveSkillFile } from "./adapters/skills/file-store.js";

export { JsonlTraceSink } from "./adapters/sinks/jsonl.js";

export { discover, parseDecision } from "./core/discover/index.js";
export type { DiscoverOptions, Decision, ActionPolicy, PolicyVerdict } from "./core/discover/index.js";
export { explore } from "./core/explore/index.js";
export type { ExploreOptions, ExploreReport } from "./core/explore/index.js";
export { deriveActionFindings, dedupeFindings } from "./core/explore/findings.js";
export type {
  ActionMark,
  ActionOutcome,
  Finding,
  FindingKind,
  FindingOptions,
  FindingSeverity,
} from "./core/explore/findings.js";
export { renderExploreReport } from "./adapters/reporters/markdown.js";
export { guessedKeyRuns, scoreTarget, scoreScenario, weakTargets } from "./core/freeze.js";
export type { GuessedKeyRun, TargetScore, ScoredTarget } from "./core/freeze.js";
export { UsageMeter, emptyUsage } from "./core/usage.js";
