/** Picks the LLM backend (invariant #5): the API if ANTHROPIC_API_KEY is set, else local Claude Code. */
import type { LlmClient } from "../../core/ports.js";
import { AnthropicLlmClient } from "./anthropic.js";
import { ClaudeCodeLlmClient } from "./claude-code.js";

export interface LlmFactoryOptions {
  /** Force a backend regardless of environment. */
  backend?: "anthropic" | "claude-code";
  model?: string;
}

export function createLlmClient(opts: LlmFactoryOptions = {}): LlmClient {
  const backend = opts.backend ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "claude-code");
  return backend === "anthropic"
    ? new AnthropicLlmClient({ model: opts.model })
    : new ClaudeCodeLlmClient({ model: opts.model });
}
