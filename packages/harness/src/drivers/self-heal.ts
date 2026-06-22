/**
 * A Driver decorator that repairs a broken step at replay time.
 *
 * Replay is normally deterministic and LLM-free (invariant #4). Self-heal is the
 * sanctioned exception: when a frozen target can no longer be resolved (a button was
 * renamed, a link moved), the LLM is asked to map the original intent onto an element
 * that exists now, the action is retried, and the substitution is recorded so the skill
 * can be re-frozen. No break → no LLM call, so healthy replays stay deterministic.
 *
 * It wraps any Driver (invariant #2/#5): heal logic is independent of the backend.
 */
import type { Driver } from "../interfaces.js";
import type { LlmClient } from "../llm/client.js";
import type { Evidence, PageElement, SettleOptions, Target } from "../types.js";

/** A recorded substitution: the original target could not be found, this name was used. */
export interface Heal {
  original: Target;
  healedText: string;
  reason?: string;
}

export interface SelfHealOptions {
  /** Cap on heal attempts per run, to bound LLM cost on a badly-broken skill. */
  maxHeals?: number;
}

const HEAL_SYSTEM =
  "You repair a broken browser test step. A step needs to act on an element described by " +
  "the original target, but no element with that name exists on the page now. Choose the " +
  "CURRENT element that best fulfills the original intent, or none if nothing fits. " +
  'Respond with strict JSON, no prose, no code fences: {"name":"<exact current element name>"} ' +
  'or {"name":null}.';

function healPrompt(target: Target, elements: PageElement[]): string {
  const want = target.text ?? target.selector ?? "(unknown)";
  const list = elements
    .slice(0, 60)
    .map((e) => `- [${e.role}] ${e.name}`)
    .join("\n");
  return [
    `Original target: ${want}`,
    ``,
    `Current interactive elements:`,
    list || "(none)",
    ``,
    `Which current element best matches the original target? JSON only.`,
  ].join("\n");
}

/** Parse the heal reply → a chosen element name, or undefined for "none". */
export function parseHealChoice(text: string): string | undefined {
  let s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`no JSON in heal reply: ${text.slice(0, 200)}`);
  const obj = JSON.parse(s.slice(start, end + 1)) as { name?: unknown };
  return typeof obj.name === "string" && obj.name.trim() ? obj.name : undefined;
}

export class SelfHealingDriver implements Driver {
  readonly heals: Heal[] = [];
  private readonly maxHeals: number;

  constructor(
    private readonly inner: Driver,
    private readonly llm: LlmClient,
    opts: SelfHealOptions = {},
  ) {
    this.maxHeals = opts.maxHeals ?? 5;
  }

  async goto(url: string): Promise<void> {
    return this.inner.goto(url);
  }

  async click(target: Target): Promise<void> {
    try {
      await this.inner.click(target);
    } catch (err) {
      const healed = await this.heal(target, err);
      await this.inner.click({ text: healed });
    }
  }

  async type(target: Target, text: string): Promise<void> {
    try {
      await this.inner.type(target, text);
    } catch (err) {
      const healed = await this.heal(target, err);
      await this.inner.type({ text: healed }, text);
    }
  }

  snapshot(): Promise<PageElement[]> {
    return this.inner.snapshot();
  }

  settle(options?: SettleOptions): Promise<void> {
    return this.inner.settle(options);
  }

  observe(): Promise<Evidence> {
    return this.inner.observe();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  /** Ask the LLM for an element that fulfills the original intent; record and return it. */
  private async heal(target: Target, cause: unknown): Promise<string> {
    if (this.heals.length >= this.maxHeals) {
      throw new Error(`self-heal budget (${this.maxHeals}) exhausted for ${JSON.stringify(target)}`);
    }
    const elements = await this.inner.snapshot();
    const reply = await this.llm.complete(healPrompt(target, elements), { system: HEAL_SYSTEM });
    const choice = parseHealChoice(reply);
    if (!choice) {
      const why = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`self-heal found no match for ${JSON.stringify(target)} (${why})`);
    }
    this.heals.push({ original: target, healedText: choice });
    return choice;
  }
}
