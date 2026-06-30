/**
 * LlmClient backed by the Google Gemini API (GEMINI_API_KEY / GOOGLE_API_KEY). Uses fetch — no SDK.
 */
import type { CompleteOptions, LlmClient } from "../../core/ports.js";
import { postJsonWithRetry } from "./http.js";

export interface GeminiOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

export class GeminiLlmClient implements LlmClient {
  readonly id: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs?: number;
  private readonly maxRetries?: number;

  constructor(opts: GeminiOptions = {}) {
    const apiKey =
      opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("GeminiLlmClient requires GEMINI_API_KEY");
    this.apiKey = apiKey;
    this.model = opts.model ?? "gemini-2.0-flash";
    this.baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com";
    this.timeoutMs = opts.timeoutMs;
    this.maxRetries = opts.maxRetries;
    this.id = `gemini:${this.model}`;
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const data = await postJsonWithRetry<GenerateResponse>(
      `${this.baseUrl}/v1beta/models/${this.model}:generateContent`,
      {
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          ...(opts.system
            ? { systemInstruction: { parts: [{ text: opts.system }] } }
            : {}),
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: opts.maxTokens ?? 1024 },
        }),
      },
      {
        timeoutMs: this.timeoutMs,
        maxRetries: this.maxRetries,
        label: "Gemini",
      },
    );
    return (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim();
  }
}
