/**
 * LlmClient backed by the Google Gemini API (GEMINI_API_KEY / GOOGLE_API_KEY). Uses fetch — no SDK.
 */
import type { CompleteOptions, LlmClient } from "../../core/ports.js";
import {
  DEFAULT_MAX_TOKENS,
  makeHttpLlmClient,
  type HttpLlmClientOptions,
  type HttpLlmClientSpec,
} from "./http-client.js";

export type GeminiOptions = HttpLlmClientOptions;

interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

const SPEC: HttpLlmClientSpec = {
  provider: "gemini",
  label: "Gemini",
  defaultModel: "gemini-2.0-flash",
  defaultBaseUrl: "https://generativelanguage.googleapis.com",
  resolveApiKey: (explicit) => {
    const apiKey =
      explicit ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("GeminiLlmClient requires GEMINI_API_KEY");
    return apiKey;
  },
  buildRequest: ({ prompt, options, model, baseUrl, apiKey }) => ({
    url: `${baseUrl}/v1beta/models/${model}:generateContent`,
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: {
      ...(options.system
        ? { systemInstruction: { parts: [{ text: options.system }] } }
        : {}),
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS },
    },
  }),
  parseResponse: (json) =>
    ((json as GenerateResponse).candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join(""),
};

export class GeminiLlmClient implements LlmClient {
  readonly id: string;
  private readonly delegate: LlmClient;

  constructor(opts: GeminiOptions = {}) {
    this.delegate = makeHttpLlmClient(SPEC, opts);
    this.id = this.delegate.id;
  }

  complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    return this.delegate.complete(prompt, opts);
  }
}
