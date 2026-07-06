import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicLlmClient } from "../../../src/adapters/llm/anthropic.js";
import { GeminiLlmClient } from "../../../src/adapters/llm/gemini.js";
import { OpenAILlmClient } from "../../../src/adapters/llm/openai.js";
import type { LlmUsage } from "../../../src/core/types.js";

const KEYS = ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];

describe("OpenAI / Gemini clients", () => {
  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it("carry their model in the id", () => {
    expect(new OpenAILlmClient({ apiKey: "k", model: "gpt-4o-mini" }).id).toBe(
      "openai:gpt-4o-mini",
    );
    expect(
      new GeminiLlmClient({ apiKey: "k", model: "gemini-1.5-pro" }).id,
    ).toBe("gemini:gemini-1.5-pro");
  });

  it("require an API key", () => {
    expect(() => new OpenAILlmClient()).toThrow(/OPENAI_API_KEY/);
    expect(() => new GeminiLlmClient()).toThrow(/GEMINI_API_KEY/);
  });

  it("Gemini accepts GOOGLE_API_KEY too", () => {
    process.env.GOOGLE_API_KEY = "g";
    expect(new GeminiLlmClient().id.startsWith("gemini:")).toBe(true);
  });
});

describe("usage reporting (#100) — each provider's response maps to onUsage", () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (json: unknown) =>
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(json), { status: 200 }));

  it("Anthropic: usage.{input,output,cache_read_input}_tokens", async () => {
    respond({
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 120, output_tokens: 8, cache_read_input_tokens: 100 },
    });
    let usage: LlmUsage | undefined;
    await new AnthropicLlmClient({ apiKey: "k" }).complete("p", { onUsage: (u) => (usage = u) });
    expect(usage).toEqual({ inputTokens: 120, outputTokens: 8, cacheReadTokens: 100 });
  });

  it("OpenAI: usage.prompt/completion_tokens (+cached)", async () => {
    respond({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 30 } },
    });
    let usage: LlmUsage | undefined;
    await new OpenAILlmClient({ apiKey: "k" }).complete("p", { onUsage: (u) => (usage = u) });
    expect(usage).toEqual({ inputTokens: 50, outputTokens: 5, cacheReadTokens: 30 });
  });

  it("Gemini: usageMetadata token counts", async () => {
    respond({
      candidates: [{ content: { parts: [{ text: "hi" }] } }],
      usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 4 },
    });
    let usage: LlmUsage | undefined;
    await new GeminiLlmClient({ apiKey: "k" }).complete("p", { onUsage: (u) => (usage = u) });
    expect(usage).toEqual({ inputTokens: 40, outputTokens: 4, cacheReadTokens: undefined });
  });

  it("stays silent when the response carries no usage", async () => {
    respond({ content: [{ type: "text", text: "hi" }] });
    let called = false;
    await new AnthropicLlmClient({ apiKey: "k" }).complete("p", { onUsage: () => (called = true) });
    expect(called).toBe(false);
  });
});
