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

export const LLM_API_KEY_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
] as const;

type ApiKeyEnvVar = (typeof LLM_API_KEY_ENV_VARS)[number];

export interface LlmFactoryOptions {
  /** Force a backend regardless of environment. */
  backend?: LlmBackend;
  model?: string;
}

interface LlmBackendStrategy {
  readonly env: readonly ApiKeyEnvVar[];
  readonly create: (model: string | undefined) => LlmClient;
}

const LLM_BACKENDS = {
  anthropic: {
    env: ["ANTHROPIC_API_KEY"],
    create: (model) => new AnthropicLlmClient({ model }),
  },
  openai: {
    env: ["OPENAI_API_KEY"],
    create: (model) => new OpenAILlmClient({ model }),
  },
  gemini: {
    env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    create: (model) => new GeminiLlmClient({ model }),
  },
  "claude-code": {
    env: [],
    create: (model) => new ClaudeCodeLlmClient({ model }),
  },
} satisfies Record<LlmBackend, LlmBackendStrategy>;

const API_BACKEND_ORDER = ["anthropic", "openai", "gemini"] as const;

function detectBackend(): LlmBackend {
  for (const backend of API_BACKEND_ORDER) {
    if (LLM_BACKENDS[backend].env.some((key) => process.env[key])) return backend;
  }
  return "claude-code";
}

export function createLlmClient(opts: LlmFactoryOptions = {}): LlmClient {
  const backend = opts.backend ?? detectBackend();
  return LLM_BACKENDS[backend].create(opts.model);
}
