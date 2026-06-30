/**
 * Picks the LLM backend (invariant #5). An explicit `backend` wins; otherwise the first provider
 * whose API key is present, in order Anthropic → OpenAI → Gemini, falling back to local Claude Code.
 */
import type { LlmClient } from "../../core/ports.js";
import { AnthropicLlmClient } from "./anthropic.js";
import { ClaudeCodeLlmClient } from "./claude-code.js";
import { GeminiLlmClient } from "./gemini.js";
import { OpenAILlmClient } from "./openai.js";

export type LlmBackend = "anthropic" | "openai" | "gemini" | "claude-code";

export interface LlmFactoryOptions {
  /** Force a backend regardless of environment. */
  backend?: LlmBackend;
  model?: string;
}

function detectBackend(): LlmBackend {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return "gemini";
  return "claude-code";
}

export function createLlmClient(opts: LlmFactoryOptions = {}): LlmClient {
  const backend = opts.backend ?? detectBackend();
  switch (backend) {
    case "openai":
      return new OpenAILlmClient({ model: opts.model });
    case "gemini":
      return new GeminiLlmClient({ model: opts.model });
    case "claude-code":
      return new ClaudeCodeLlmClient({ model: opts.model });
    default:
      return new AnthropicLlmClient({ model: opts.model });
  }
}
