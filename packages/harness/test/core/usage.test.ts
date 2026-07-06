import { describe, expect, it } from "vitest";
import { UsageMeter, emptyUsage } from "../../src/core/usage.js";
import type { CompleteOptions, LlmClient } from "../../src/core/ports.js";

function backend(report?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }): LlmClient {
  return {
    id: "fake:model",
    async complete(_prompt: string, opts: CompleteOptions = {}) {
      if (report) opts.onUsage?.(report);
      return "ok";
    },
  };
}

describe("UsageMeter", () => {
  it("counts every call exactly, even when the backend reports nothing", async () => {
    const meter = new UsageMeter(backend());
    await meter.complete("a");
    await meter.complete("b");
    expect(meter.snapshot()).toEqual({ ...emptyUsage(), llmCalls: 2 });
  });

  it("sums reported usage and tracks how many calls were measured", async () => {
    const meter = new UsageMeter(backend({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 80 }));
    await meter.complete("a");
    await meter.complete("b");
    expect(meter.snapshot()).toEqual({
      llmCalls: 2,
      measuredCalls: 2,
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 160,
    });
  });

  it("forwards usage to a caller's own onUsage", async () => {
    const meter = new UsageMeter(backend({ inputTokens: 5 }));
    let seen = 0;
    await meter.complete("a", { onUsage: (u) => (seen = u.inputTokens ?? 0) });
    expect(seen).toBe(5);
  });

  it("snapshot() is a copy — later calls don't mutate an earlier snapshot", async () => {
    const meter = new UsageMeter(backend());
    const before = meter.snapshot();
    await meter.complete("a");
    expect(before.llmCalls).toBe(0);
    expect(meter.snapshot().llmCalls).toBe(1);
  });
});
