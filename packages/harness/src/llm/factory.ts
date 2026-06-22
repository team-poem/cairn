/**
 * Picks the LLM backend. Default policy keeps the core model-agnostic (invariant #5)
 * and makes swapping trivial: set a key and you get the API; otherwise fall back to the
 * locally-installed Claude Code. Callers can also pass an explicit client to override.
 */
import type { LlmClient } from "./client.js";
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
