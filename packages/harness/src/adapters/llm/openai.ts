/**
 * LlmClient backed by the OpenAI Chat Completions API (OPENAI_API_KEY). Uses fetch — no SDK.
 */
import type { CompleteOptions, LlmClient } from "../../core/ports.js";
import {
  DEFAULT_MAX_TOKENS,
  makeHttpLlmClient,
  type HttpLlmClientOptions,
  type HttpLlmClientSpec,
} from "./http-client.js";

export type OpenAIOptions = HttpLlmClientOptions;

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

const SPEC: HttpLlmClientSpec = {
  provider: "openai",
  label: "OpenAI",
  defaultModel: "gpt-4o",
  defaultBaseUrl: "https://api.openai.com",
  resolveApiKey: (explicit) => {
    const apiKey = explicit ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OpenAILlmClient requires OPENAI_API_KEY");
    return apiKey;
  },
  buildRequest: ({ prompt, options, model, baseUrl, apiKey }) => {
    const messages: Array<{ role: string; content: string }> = [];
    if (options.system) messages.push({ role: "system", content: options.system });
    messages.push({ role: "user", content: prompt });
    return {
      url: `${baseUrl}/v1/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: { model, max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS, messages },
    };
  },
  parseResponse: (json) =>
    (json as ChatResponse).choices?.[0]?.message?.content ?? "",
};

export class OpenAILlmClient implements LlmClient {
  readonly id: string;
  private readonly delegate: LlmClient;

  constructor(opts: OpenAIOptions = {}) {
    this.delegate = makeHttpLlmClient(SPEC, opts);
    this.id = this.delegate.id;
  }

  complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    return this.delegate.complete(prompt, opts);
  }
}
