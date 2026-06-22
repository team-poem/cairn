import { describe, expect, it, vi } from "vitest";
import { LlmCritic } from "./llm.js";
import type { LlmClient } from "../../core/ports.js";
import type { Evidence } from "../../core/types.js";

class ScriptedLlm implements LlmClient {
  readonly id = "scripted";
  calls = 0;
  constructor(private readonly reply: string) {}
  async complete(): Promise<string> {
    this.calls++;
    return this.reply;
  }
}

const evidence: Evidence = {
  execution: { actions: [], navigated: true, finalUrl: "https://shop/confirmation", blocked: false },
  perception: {},
  logic: {
    requests: [{ method: "GET", url: "/api/orders", status: 200 }],
    console: [],
  },
};

describe("LlmCritic", () => {
  it("judges an `expect` criterion via the LLM", async () => {
    const llm = new ScriptedLlm('{"passed":true,"detail":"confirmation page reached"}');
    const critic = new LlmCritic(llm);
    const verdict = await critic.judge(evidence, [{ kind: "expect", criterion: "order confirmation is shown" }]);
    expect(verdict.passed).toBe(true);
    expect(verdict.results[0]?.detail).toBe("confirmation page reached");
    expect(llm.calls).toBe(1);
  });

  it("makes ZERO LLM calls when there are no `expect` criteria (stays deterministic)", async () => {
    const llm = new ScriptedLlm("{}");
    const spy = vi.spyOn(llm, "complete");
    const critic = new LlmCritic(llm);
    const verdict = await critic.judge(evidence, [{ kind: "navigated" }, { kind: "no-failed-requests" }]);
    expect(verdict.passed).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails the criterion (not the run) when the LLM errors", async () => {
    const llm: LlmClient = {
      id: "boom",
      async complete() {
        throw new Error("network down");
      },
    };
    const critic = new LlmCritic(llm);
    const verdict = await critic.judge(evidence, [{ kind: "expect", criterion: "x" }]);
    expect(verdict.passed).toBe(false);
    expect(verdict.results[0]?.detail).toContain("LLM judgment failed");
  });
});
