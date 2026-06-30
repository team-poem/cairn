/**
 * Shared POST-JSON transport for the HTTP-based LlmClient adapters (Anthropic, OpenAI, Gemini):
 * a per-request timeout plus exponential back-off on transient failures (429 / 5xx / timeout).
 * Each adapter builds its own request body and parses its own response shape.
 */
const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export interface HttpRetryOptions {
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });
      if (res.ok) return (await res.json()) as T;
      // Back off on transient errors (rate limit / overloaded / server), else fail.
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await delay(500 * 2 ** attempt);
        continue;
      }
      throw new Error(`${label} API ${res.status}: ${await res.text()}`);
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      if (aborted && attempt >= maxRetries)
        throw new Error(`${label} request timed out after ${timeoutMs}ms`);
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
