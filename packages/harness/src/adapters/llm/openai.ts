/**
 * LlmClient backed by the OpenAI Chat Completions API (OPENAI_API_KEY). Uses fetch — no SDK.
 */
import type { CompleteOptions, LlmClient } from "../../core/ports.js";
import { postJsonWithRetry } from "./http.js";

export interface OpenAIOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class OpenAILlmClient implements LlmClient {
  readonly id: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs?: number;
  private readonly maxRetries?: number;

  constructor(opts: OpenAIOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OpenAILlmClient requires OPENAI_API_KEY");
    this.apiKey = apiKey;
    this.model = opts.model ?? "gpt-4o";
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com";
    this.timeoutMs = opts.timeoutMs;
    this.maxRetries = opts.maxRetries;
    this.id = `openai:${this.model}`;
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: prompt });

    const data = await postJsonWithRetry<ChatResponse>(
      `${this.baseUrl}/v1/chat/completions`,
      {
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: opts.maxTokens ?? 1024,
          messages,
        }),
      },
      {
        timeoutMs: this.timeoutMs,
        maxRetries: this.maxRetries,
        label: "OpenAI",
      },
    );
    return (data.choices?.[0]?.message?.content ?? "").trim();
  }
}
