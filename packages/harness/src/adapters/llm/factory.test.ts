import { beforeEach, describe, expect, it } from "vitest";
import { createLlmClient, type LlmBackend } from "./factory.js";

const KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

describe("createLlmClient", () => {
  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it("uses Claude Code when forced (no key needed)", () => {
    expect(createLlmClient({ backend: "claude-code", model: "haiku" }).id).toBe(
      "claude-code:haiku",
    );
  });

  it("builds an Anthropic client when forced", () => {
    process.env.ANTHROPIC_API_KEY = "a-test";
    expect(createLlmClient({ backend: "anthropic" }).id.startsWith("anthropic:")).toBe(
      true,
    );
  });

  it("throws on an unknown backend instead of silently defaulting", () => {
    expect(() =>
      createLlmClient({ backend: "mistral" as unknown as LlmBackend }),
    ).toThrow(/Unknown LLM backend: mistral/);
  });

  it("rejects prototype keys (__proto__, constructor) rather than resolving them", () => {
    expect(() =>
      createLlmClient({ backend: "__proto__" as unknown as LlmBackend }),
    ).toThrow(/Unknown LLM backend: __proto__/);
    expect(() =>
      createLlmClient({ backend: "constructor" as unknown as LlmBackend }),
    ).toThrow(/Unknown LLM backend: constructor/);
  });

  it("builds an OpenAI client when forced", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    expect(createLlmClient({ backend: "openai" }).id).toBe("openai:gpt-4o");
  });

  it("builds a Gemini client when forced", () => {
    process.env.GEMINI_API_KEY = "g-test";
    expect(createLlmClient({ backend: "gemini" }).id).toBe(
      "gemini:gemini-2.0-flash",
    );
  });

  it("detects from env — Anthropic wins over OpenAI", () => {
    process.env.ANTHROPIC_API_KEY = "a";
    process.env.OPENAI_API_KEY = "b";
    expect(createLlmClient().id.startsWith("anthropic:")).toBe(true);
  });

  it("falls through OpenAI → Gemini → Claude Code", () => {
    process.env.OPENAI_API_KEY = "b";
    expect(createLlmClient().id.startsWith("openai:")).toBe(true);
    delete process.env.OPENAI_API_KEY;
    process.env.GOOGLE_API_KEY = "c";
    expect(createLlmClient().id.startsWith("gemini:")).toBe(true);
    delete process.env.GOOGLE_API_KEY;
    expect(createLlmClient().id.startsWith("claude-code:")).toBe(true);
  });
});
