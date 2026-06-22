import { describe, expect, it } from "vitest";
import { createLlmClient } from "./factory.js";

describe("createLlmClient", () => {
  it("uses Claude Code when forced (no key needed)", () => {
    const client = createLlmClient({ backend: "claude-code", model: "haiku" });
    expect(client.id).toBe("claude-code:haiku");
  });

  it("selects a backend from the environment", () => {
    // Without forcing, selection follows ANTHROPIC_API_KEY presence.
    const client = createLlmClient({ backend: "claude-code" });
    expect(client.id.startsWith("claude-code:")).toBe(true);
  });
});
