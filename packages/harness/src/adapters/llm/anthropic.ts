/**
 * LlmClient backed by the Anthropic Messages API (ANTHROPIC_API_KEY) — the standalone
 * default once a user supplies a key. Uses fetch to avoid an SDK dependency.
 */
import type { CompleteOptions, LlmClient } from "../../core/ports.js";
import {
  DEFAULT_MAX_TOKENS,
  makeHttpLlmClient,
  type HttpLlmClientOptions,
  type HttpLlmClientSpec,
} from "./http-client.js";

export type AnthropicOptions = HttpLlmClientOptions;

interface MessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

const SPEC: HttpLlmClientSpec = {
  provider: "anthropic",
  label: "Anthropic",
  defaultModel: "claude-sonnet-4-6",
  defaultBaseUrl: "https://api.anthropic.com",
  resolveApiKey: (explicit) => {
    const apiKey = explicit ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("AnthropicLlmClient requires ANTHROPIC_API_KEY");
    return apiKey;
  },
  buildRequest: ({ prompt, options, model, baseUrl, apiKey }) => ({
    url: `${baseUrl}/v1/messages`,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: {
      model,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      // #15 — cache the (constant) system prompt so repeated discover steps don't re-bill it.
      ...(options.system
        ? {
            system: [
              {
                type: "text",
                text: options.system,
                cache_control: { type: "ephemeral" },
              },
            ],
          }
        : {}),
      messages: [{ role: "user", content: prompt }],
    },
  }),
  parseResponse: (json) =>
    ((json as MessagesResponse).content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join(""),
};

export class AnthropicLlmClient implements LlmClient {
  readonly id: string;
  private readonly delegate: LlmClient;

  constructor(opts: AnthropicOptions = {}) {
    this.delegate = makeHttpLlmClient(SPEC, opts);
    this.id = this.delegate.id;
  }

  complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    return this.delegate.complete(prompt, opts);
  }
}
