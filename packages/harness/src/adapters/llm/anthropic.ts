/**
 * LlmClient backed by the Anthropic Messages API (ANTHROPIC_API_KEY) — the standalone
 * default once a user supplies a key. Uses fetch to avoid an SDK dependency.
 */
import type { CompleteOptions, LlmClient } from "../../core/ports.js";
import { postJsonWithRetry } from "./http.js";

export interface AnthropicOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Per-request timeout (ms). Default 60s — a stalled connection rejects instead of hanging. */
  timeoutMs?: number;
  /** Retries on transient errors (429 / 5xx). Default 2. */
  maxRetries?: number;
}

interface MessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

export class AnthropicLlmClient implements LlmClient {
  readonly id: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: AnthropicOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey)
      throw new Error("AnthropicLlmClient requires ANTHROPIC_API_KEY");
    this.apiKey = apiKey;
    this.model = opts.model ?? "claude-sonnet-4-6";
    this.baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.id = `anthropic:${this.model}`;
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const data = await postJsonWithRetry<MessagesResponse>(
      `${this.baseUrl}/v1/messages`,
      {
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: opts.maxTokens ?? 1024,
          // #15 — cache the (constant) system prompt so repeated discover steps don't re-bill it.
          ...(opts.system
            ? {
                system: [
                  {
                    type: "text",
                    text: opts.system,
                    cache_control: { type: "ephemeral" },
                  },
                ],
              }
            : {}),
          messages: [{ role: "user", content: prompt }],
        }),
      },
      {
        timeoutMs: this.timeoutMs,
        maxRetries: this.maxRetries,
        label: "Anthropic",
      },
    );
    return (data.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("")
      .trim();
  }
}
