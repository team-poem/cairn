/**
 * LLM usage accounting at the seam (invariant #5): the meter wraps any LlmClient — engine
 * defaults and host-injected clients alike — counting every completion exactly and summing
 * whatever usage the backend reports. The engine aggregates; it never fabricates numbers.
 */
import type { CompleteOptions, LlmClient } from "./ports.js";
import type { RunUsage } from "./types.js";

export function emptyUsage(): RunUsage {
  return { llmCalls: 0, measuredCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
}

export class UsageMeter implements LlmClient {
  readonly id: string;
  private readonly total = emptyUsage();

  constructor(private readonly inner: LlmClient) {
    this.id = inner.id;
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    this.total.llmCalls++;
    return this.inner.complete(prompt, {
      ...opts,
      onUsage: (u) => {
        this.total.measuredCalls++;
        this.total.inputTokens += u.inputTokens ?? 0;
        this.total.outputTokens += u.outputTokens ?? 0;
        this.total.cacheReadTokens += u.cacheReadTokens ?? 0;
        opts.onUsage?.(u);
      },
    });
  }

  snapshot(): RunUsage {
    return { ...this.total };
  }
}
