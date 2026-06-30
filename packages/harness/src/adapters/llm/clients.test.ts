import { beforeEach, describe, expect, it } from "vitest";
import { GeminiLlmClient } from "./gemini.js";
import { OpenAILlmClient } from "./openai.js";

describe("OpenAI / Gemini clients", () => {
  beforeEach(() => {
    for (const k of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"])
      delete process.env[k];
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
