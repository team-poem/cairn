import { describe, expect, it, vi } from "vitest";
import { LlmCritic } from "../../../src/adapters/critics/llm.js";
import type { LlmClient } from "../../../src/core/ports.js";
import type { Evidence } from "../../../src/core/types.js";

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

  it("fails closed on an empty assertion set without calling the LLM (#69)", async () => {
    const llm = new ScriptedLlm("{}");
    const spy = vi.spyOn(llm, "complete");
    const verdict = await new LlmCritic(llm).judge(evidence, []);
    expect(verdict.passed).toBe(false);
    expect(verdict.detail).toContain("no assertions");
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

  it("grounds the LLM judgment in the run's intent when context provides one", async () => {
    let captured = "";
    const llm: LlmClient = {
      id: "capture",
      async complete(prompt: string) {
        captured = prompt;
        return '{"passed":true,"detail":"ok"}';
      },
    };
    const critic = new LlmCritic(llm);
    await critic.judge(
      evidence,
      [{ kind: "expect", criterion: "order confirmation is shown" }],
      { intent: "complete the book checkout" },
    );
    expect(captured).toContain("Task intent: complete the book checkout");
  });

  it("omits the intent line when no context is given", async () => {
    let captured = "";
    const llm: LlmClient = {
      id: "capture",
      async complete(prompt: string) {
        captured = prompt;
        return '{"passed":true}';
      },
    };
    const critic = new LlmCritic(llm);
    await critic.judge(evidence, [{ kind: "expect", criterion: "x" }]);
    expect(captured).not.toContain("Task intent:");
  });
});

import { ExpectAssertionHandler, summarizeEvidence } from "../../../src/adapters/critics/llm.js";

// Consolidated audit coverage.

{

  class ScriptedLlm implements LlmClient {
    readonly id = "scripted";
    constructor(private readonly reply: string) {}
    async complete(): Promise<string> {
      return this.reply;
    }
  }

  const evidence: Evidence = {
    execution: { actions: [], navigated: true, finalUrl: "https://shop/done", blocked: false },
    perception: {},
    logic: { requests: [], console: [] },
  };

  // critic-detail-falls-back-to-judged-by.test.ts
  {
    describe("critics/llm parseVerdict", () => {
      it("criticDetailFallsBackToJudgedBy: a verdict without a string detail reads `judged by <llm.id>`", async () => {
        const h = new ExpectAssertionHandler(new ScriptedLlm('{"passed":false,"detail":42}'));
        const r = await h.judge({ kind: "expect", criterion: "c" }, evidence);
        expect(r).toEqual({ assertion: { kind: "expect", criterion: "c" }, passed: false, detail: "judged by scripted" });
      });
    });
  }

  // critic-expect-handler-rejects-other-kinds.test.ts
  {
    describe("critics/llm ExpectAssertionHandler", () => {
      it("criticExpectHandlerRejectsOtherKinds: supports() is true only for expect, and judge() on another kind throws", async () => {
        const h = new ExpectAssertionHandler(new ScriptedLlm("{}"));
        expect(h.supports({ kind: "expect", criterion: "c" })).toBe(true);
        expect(h.supports({ kind: "no-console-errors" })).toBe(false);
        await expect(h.judge({ kind: "no-console-errors" }, evidence)).rejects.toThrow('expect handler received "no-console-errors" assertion');
      });
    });
  }

  // critic-summary-caps-requests-at-forty.test.ts
  {
    describe("critics/llm summarizeEvidence", () => {
      it("criticSummaryCapsRequestsAtForty: the header counts every request but only the first 40 are listed — a failing 41st is absent", () => {
        const requests = Array.from({ length: 41 }, (_, i) => ({
          method: "GET",
          url: `https://x/${i}`,
          status: i === 40 ? 500 : 200,
        }));
        const text = summarizeEvidence({ ...evidence, logic: { requests, console: [{ type: "error", text: "boom" }, { type: "log", text: "hi" }] } });
        expect(text).toContain("requests (41):");
        expect(text).toContain("200 GET https://x/39");
        expect(text).not.toContain("https://x/40");
        expect(text).not.toContain("500");
        expect(text).toContain("console errors (1):\nboom");
        expect(text).not.toContain("hi");
      });
    });
  }

  // critic-verdict-requires-json.test.ts
  {
    describe("critics/llm parseVerdict", () => {
      it("criticVerdictRequiresJson: a reply with no JSON object fails the criterion with `no JSON in critic reply`", async () => {
        const h = new ExpectAssertionHandler(new ScriptedLlm("Yes, it passed."));
        const r = await h.judge({ kind: "expect", criterion: "order confirmed" }, evidence);
        expect(r.passed).toBe(false);
        expect(r.detail).toMatch(/^LLM judgment failed: no JSON in critic reply: Yes, it passed\./);
      });
    });
  }

  // critic-verdict-string-true-is-not-a-pass.test.ts
  {
    describe("critics/llm parseVerdict", () => {
      it("criticVerdictStringTrueIsNotAPass: passed given as the string true judges as failed; only boolean true passes", async () => {
        const stringy = await new ExpectAssertionHandler(new ScriptedLlm('{"passed":"true","detail":"looks fine"}')).judge(
          { kind: "expect", criterion: "c" },
          evidence,
        );
        expect(stringy.passed).toBe(false);
        expect(stringy.detail).toBe("looks fine");
        const real = await new ExpectAssertionHandler(new ScriptedLlm('Sure:\n{"passed":true,"detail":"ok"}')).judge(
          { kind: "expect", criterion: "c" },
          evidence,
        );
        expect(real.passed).toBe(true);
      });
    });
  }

}
