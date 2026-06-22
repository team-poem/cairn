/**
 * LlmClient backed by the Anthropic Messages API (ANTHROPIC_API_KEY) — the standalone
 * default once a user supplies a key. Uses fetch to avoid an SDK dependency.
 */
import type { CompleteOptions, LlmClient } from "../../core/ports.js";

export interface AnthropicOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

interface MessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

export class AnthropicLlmClient implements LlmClient {
  readonly id: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: AnthropicOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("AnthropicLlmClient requires ANTHROPIC_API_KEY");
    this.apiKey = apiKey;
    this.model = opts.model ?? "claude-sonnet-4-6";
    this.baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
    this.id = `anthropic:${this.model}`;
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens ?? 1024,
        ...(opts.system ? { system: opts.system } : {}),
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as MessagesResponse;
    return (data.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("")
      .trim();
  }
}
