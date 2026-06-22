/**
 * Model-agnostic LLM seam (invariant #5: no LLM is hard-wired into the core).
 *
 * The discover loop and any future LLM critic depend on this interface, never on a
 * concrete provider. Implementations live alongside; `createLlmClient` picks one.
 */
export interface LlmClient {
  /** A short identifier of the backing model/runtime, for reporting. */
  readonly id: string;
  /** Complete a single prompt and return the text. */
  complete(prompt: string, opts?: CompleteOptions): Promise<string>;
}

export interface CompleteOptions {
  /** Steering system prompt. */
  system?: string;
  /** Upper bound on output tokens (best-effort per backend). */
  maxTokens?: number;
}
