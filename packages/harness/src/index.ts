/** Public surface of @cairn/harness. */
export * from "./types.js";
export * from "./interfaces.js";
export { runHarness } from "./pipeline.js";

export { InlineContextProvider } from "./context/inline.js";
export { StaticPlanner } from "./planners/static.js";
export { AssertionCritic, checkAssertion } from "./critics/assertion.js";
export { LlmCritic, summarizeEvidence } from "./critics/llm.js";
export { ConsoleReporter } from "./reporters/console.js";
export { JsonReporter } from "./reporters/json.js";
export { FakeDriver } from "./drivers/fake.js";
export { ChromeDevToolsDriver } from "./drivers/chrome.js";

export type { LlmClient, CompleteOptions } from "./llm/client.js";
export { ClaudeCodeLlmClient } from "./llm/claude-code.js";
export { AnthropicLlmClient } from "./llm/anthropic.js";
export { createLlmClient } from "./llm/factory.js";

export { FileSkillStore, loadSkillFile } from "./skills/file-store.js";

export { discover, parseDecision } from "./discover.js";
export type { DiscoverOptions, Decision } from "./discover.js";
