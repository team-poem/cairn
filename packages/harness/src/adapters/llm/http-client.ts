/**
 * Shared scaffolding for the HTTP-based LlmClient adapters (Anthropic, OpenAI, Gemini). Every such
 * backend resolves an API key (explicit or from the environment), defaults a model and base URL,
 * exposes an id of `${provider}:${model}`, POSTs one JSON request through {@link postJsonWithRetry},
 * and trims the extracted text. `makeHttpLlmClient` owns all of that; an adapter supplies only the
 * parts that actually differ via an {@link HttpLlmClientSpec}.
 */
import type { CompleteOptions, LlmClient } from "../../core/ports.js";
import { postJsonWithRetry } from "./http.js";

/** Default completion token budget shared by the HTTP LLM adapters. */
export const DEFAULT_MAX_TOKENS = 1024;

/** Construction options common to every HTTP-based LlmClient adapter. */
export interface HttpLlmClientOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Per-request timeout (ms). Defaults come from {@link postJsonWithRetry}. */
  timeoutMs?: number;
  /** Retries on transient errors (429 / 5xx / timeout). Defaults come from {@link postJsonWithRetry}. */
  maxRetries?: number;
}

/** The per-provider wiring — the only parts that differ between HTTP backends. */
export interface HttpLlmClientSpec {
  /** Id prefix; the client id is `${provider}:${model}`. */
  provider: string;
  /** Provider label for transport error messages, e.g. "OpenAI". */
  label: string;
  defaultModel: string;
  defaultBaseUrl: string;
  /** Resolve the API key from the explicit option or the environment; throw if absent. */
  resolveApiKey(explicit: string | undefined): string;
  /** Build the request URL, headers, and (unserialised) body for one completion. */
  buildRequest(ctx: {
    prompt: string;
    options: CompleteOptions;
    model: string;
    baseUrl: string;
    apiKey: string;
  }): { url: string; headers: Record<string, string>; body: unknown };
  /** Pull the completion text out of the parsed JSON response ("" when absent). */
  parseResponse(json: unknown): string;
}

/**
 * Assemble an {@link LlmClient} from provider-specific wiring. Resolves the key (may throw) and the
 * model/baseUrl defaults eagerly, so construction fails fast on a missing key exactly as before.
 */
export function makeHttpLlmClient(
  spec: HttpLlmClientSpec,
  opts: HttpLlmClientOptions = {},
): LlmClient {
  const apiKey = spec.resolveApiKey(opts.apiKey);
  const model = opts.model ?? spec.defaultModel;
  const baseUrl = opts.baseUrl ?? spec.defaultBaseUrl;

  return {
    id: `${spec.provider}:${model}`,
    async complete(prompt: string, options: CompleteOptions = {}): Promise<string> {
      const req = spec.buildRequest({ prompt, options, model, baseUrl, apiKey });
      const json = await postJsonWithRetry<unknown>(
        req.url,
        { headers: req.headers, body: JSON.stringify(req.body) },
        { timeoutMs: opts.timeoutMs, maxRetries: opts.maxRetries, label: spec.label },
      );
      return spec.parseResponse(json).trim();
    },
  };
}
