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

/**
 * Strategy registry: each backend owns its client constructor. Adding a backend is one entry here —
 * no control-flow edit — and an unrecognised backend is a lookup miss (surfaced below) rather than a
 * silent default. A Map (not a plain object) so stray keys like "__proto__"/"constructor" miss
 * cleanly instead of resolving to something on Object.prototype.
 */
const BACKENDS = new Map<LlmBackend, (opts: LlmFactoryOptions) => LlmClient>([
  ["anthropic", (o) => new AnthropicLlmClient({ model: o.model })],
  ["openai", (o) => new OpenAILlmClient({ model: o.model })],
  ["gemini", (o) => new GeminiLlmClient({ model: o.model })],
  ["claude-code", (o) => new ClaudeCodeLlmClient({ model: o.model })],
]);

export function createLlmClient(opts: LlmFactoryOptions = {}): LlmClient {
  const backend = opts.backend ?? detectBackend();
  const make = BACKENDS.get(backend);
  if (!make) throw new Error(`Unknown LLM backend: ${backend}`);
  return make(opts);
}
