/**
 * Shared POST-JSON transport for the HTTP-based LlmClient adapters (Anthropic, OpenAI, Gemini):
 * a per-request timeout plus exponential back-off on transient failures (429 / 5xx / timeout).
 * Each adapter builds its own request body and parses its own response shape.
 */
import { combineSignals } from "../../core/abort.js";

const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });

export interface HttpRetryOptions {
  signal?: AbortSignal;
  /** Per-request timeout (ms). Default 60s — a stalled connection rejects instead of hanging. */
  timeoutMs?: number;
  /** Retries on transient errors (429 / 5xx / timeout). Default 2. */
  maxRetries?: number;
  /** Provider name for error messages, e.g. "Anthropic". */
  label?: string;
}

export async function postJsonWithRetry<T>(
  url: string,
  init: { headers: Record<string, string>; body: string },
  opts: HttpRetryOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxRetries = opts.maxRetries ?? 2;
  const label = opts.label ?? "LLM";

  for (let attempt = 0; ; attempt++) {
    opts.signal?.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const combined = combineSignals(opts.signal ? [controller.signal, opts.signal] : [controller.signal]);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: init.headers,
        body: init.body,
        signal: combined.signal,
      });
      if (res.ok) {
        const value = await res.json() as T;
        opts.signal?.throwIfAborted();
        return value;
      }
      // Back off on transient errors (rate limit / overloaded / server), else fail.
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await delay(500 * 2 ** attempt, opts.signal);
        continue;
      }
      throw new Error(`${label} API ${res.status}: ${await res.text()}`);
    } catch (err) {
      opts.signal?.throwIfAborted();
      const aborted = err instanceof Error && err.name === "AbortError";
      if (aborted && attempt >= maxRetries)
        throw new Error(`${label} request timed out after ${timeoutMs}ms`);
      if (aborted) {
        await delay(500 * 2 ** attempt, opts.signal);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      combined.dispose();
    }
  }
}
