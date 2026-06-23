/**
 * LlmClient backed by the Anthropic Messages API (ANTHROPIC_API_KEY) — the standalone
 * default once a user supplies a key. Uses fetch to avoid an SDK dependency.
 */
import type { CompleteOptions, LlmClient } from "../../core/ports.js";

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

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class AnthropicLlmClient implements LlmClient {
  readonly id: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: AnthropicOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("AnthropicLlmClient requires ANTHROPIC_API_KEY");
    this.apiKey = apiKey;
    this.model = opts.model ?? "claude-sonnet-4-6";
    this.baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.id = `anthropic:${this.model}`;
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const body = JSON.stringify({
      model: this.model,
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.system ? { system: opts.system } : {}),
      messages: [{ role: "user", content: prompt }],
    });

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body,
          signal: controller.signal,
        });
        if (res.ok) {
          const data = (await res.json()) as MessagesResponse;
          return (data.content ?? [])
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text)
            .join("")
            .trim();
        }
        // Back off on transient errors (rate limit / overloaded / server), else fail.
        if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
          await delay(500 * 2 ** attempt);
          continue;
        }
        throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        if (aborted && attempt >= this.maxRetries) throw new Error(`Anthropic request timed out after ${this.timeoutMs}ms`);
        if (aborted) {
          await delay(500 * 2 ** attempt);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  }
}
