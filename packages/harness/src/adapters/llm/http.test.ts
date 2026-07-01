import { afterEach, describe, expect, it, vi } from "vitest";
import { postJsonWithRetry } from "./http.js";
import { AnthropicLlmClient } from "./anthropic.js";
import { GeminiLlmClient } from "./gemini.js";
import { OpenAILlmClient } from "./openai.js";

/** A minimal fetch Response stand-in — only the members postJsonWithRetry touches. */
function res(
  body: unknown,
  opts: { ok?: boolean; status?: number; text?: string } = {},
): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
    text: async () => opts.text ?? "",
  } as unknown as Response;
}

/** An error shaped like a fetch abort (what an AbortController triggers on timeout). */
function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

describe("postJsonWithRetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns the parsed body and issues a POST with the given headers and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(res({ ok: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await postJsonWithRetry(
      "https://api.example/v1",
      { headers: { "x-h": "v" }, body: "PAYLOAD" },
      { label: "Example" },
    );

    expect(out).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.example/v1");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "x-h": "v" });
    expect(init.body).toBe("PAYLOAD");
    expect(init.signal).toBeDefined(); // per-request timeout wired up
  });

  it("retries a 429 and returns the eventual success", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(null, { ok: false, status: 429, text: "slow down" }))
      .mockResolvedValueOnce(res({ ok: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    const p = postJsonWithRetry("https://x", { headers: {}, body: "" });
    await vi.runAllTimersAsync();

    expect(await p).toEqual({ ok: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx and returns the eventual success", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(null, { ok: false, status: 503, text: "overloaded" }))
      .mockResolvedValueOnce(res({ ok: 3 }));
    vi.stubGlobal("fetch", fetchMock);

    const p = postJsonWithRetry("https://x", { headers: {}, body: "" });
    await vi.runAllTimersAsync();

    expect(await p).toEqual({ ok: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries on a persistent 5xx, tagged with label and status", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(res(null, { ok: false, status: 500, text: "boom" }));
    vi.stubGlobal("fetch", fetchMock);

    const p = postJsonWithRetry(
      "https://x",
      { headers: {}, body: "" },
      { maxRetries: 2, label: "OpenAI" },
    );
    p.catch(() => {}); // avoid an unhandled rejection while timers flush
    await vi.runAllTimersAsync();

    await expect(p).rejects.toThrow(/OpenAI API 500: boom/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does not retry a non-retryable 4xx — it fails fast", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(res(null, { ok: false, status: 400, text: "bad request" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      postJsonWithRetry("https://x", { headers: {}, body: "" }, { label: "Gemini" }),
    ).rejects.toThrow(/Gemini API 400: bad request/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps an aborted request to a timeout error naming the deadline", async () => {
    const fetchMock = vi.fn().mockRejectedValue(abortError());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      postJsonWithRetry(
        "https://x",
        { headers: {}, body: "" },
        { maxRetries: 0, timeoutMs: 1234, label: "Anthropic" },
      ),
    ).rejects.toThrow(/Anthropic request timed out after 1234ms/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries an aborted request before giving up with a timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(abortError());
    vi.stubGlobal("fetch", fetchMock);

    const p = postJsonWithRetry("https://x", { headers: {}, body: "" }, { maxRetries: 1 });
    p.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(p).rejects.toThrow(/timed out/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it("surfaces a non-abort connection error immediately, without retrying", async () => {
    // Documents CURRENT behavior: connection-level failures (ECONNRESET / DNS / undici
    // 'fetch failed') are rethrown raw on the first attempt — not retried, and without a
    // provider label. See the transport code-smell review for the argument to retry these.
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      postJsonWithRetry("https://x", { headers: {}, body: "" }, { maxRetries: 2 }),
    ).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("OpenAILlmClient.complete", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds a Chat Completions request and returns the trimmed message content", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(res({ choices: [{ message: { content: "  hi there  " } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenAILlmClient({ apiKey: "sk", model: "gpt-4o-mini" });
    const out = await client.complete("do it", { system: "be terse", maxTokens: 42 });

    expect(out).toBe("hi there");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer sk");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.max_tokens).toBe(42);
    expect(body.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "do it" },
    ]);
  });

  it("omits the system message and defaults max_tokens when not given", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(res({ choices: [{ message: { content: "x" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await new OpenAILlmClient({ apiKey: "sk" }).complete("q");

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.messages).toEqual([{ role: "user", content: "q" }]);
    expect(body.max_tokens).toBe(1024);
  });

  it("returns an empty string on a malformed/empty response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res({})));
    expect(await new OpenAILlmClient({ apiKey: "sk" }).complete("q")).toBe("");
  });
});

describe("GeminiLlmClient.complete", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds a generateContent request with systemInstruction and joins the part texts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      res({ candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new GeminiLlmClient({ apiKey: "g", model: "gemini-2.0-flash" });
    const out = await client.complete("q", { system: "sys" });

    expect(out).toBe("ab");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    );
    expect(init.headers["x-goog-api-key"]).toBe("g");
    const body = JSON.parse(init.body);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "sys" }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "q" }] }]);
    expect(body.generationConfig.maxOutputTokens).toBe(1024);
  });

  it("omits systemInstruction when no system prompt is given", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(res({ candidates: [{ content: { parts: [{ text: "x" }] } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await new GeminiLlmClient({ apiKey: "g" }).complete("q");

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.systemInstruction).toBeUndefined();
  });

  it("returns an empty string when the response has no candidates", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res({})));
    expect(await new GeminiLlmClient({ apiKey: "g" }).complete("q")).toBe("");
  });
});

describe("AnthropicLlmClient.complete", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds a Messages request that caches the system prompt and joins text blocks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      res({
        content: [
          { type: "text", text: "foo" },
          { type: "tool_use" },
          { type: "text", text: "bar" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new AnthropicLlmClient({ apiKey: "ak", model: "claude-x" });
    const out = await client.complete("q", { system: "S" });

    expect(out).toBe("foobar"); // non-text blocks filtered, text joined
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("ak");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("claude-x");
    expect(body.system).toEqual([
      { type: "text", text: "S", cache_control: { type: "ephemeral" } },
    ]);
    expect(body.messages).toEqual([{ role: "user", content: "q" }]);
  });

  it("omits the system field when no system prompt is given", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(res({ content: [{ type: "text", text: "x" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await new AnthropicLlmClient({ apiKey: "ak" }).complete("q");

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.system).toBeUndefined();
  });

  it("returns an empty string when the response carries no text blocks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(res({ content: [{ type: "tool_use" }] })),
    );
    expect(await new AnthropicLlmClient({ apiKey: "ak" }).complete("q")).toBe("");
  });
});
