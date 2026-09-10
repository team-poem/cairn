/**
 * A Driver decorator (wraps any Driver) that repairs a broken step at replay time — the
 * sanctioned exception to LLM-free replay (invariant #4). When a frozen target no longer
 * resolves, the LLM maps the original intent onto a current element, the action is retried,
 * and the substitution is recorded for re-freezing. No break → no LLM call.
 */
import type { Driver, LlmClient, PerceptionAdapter } from "../../core/ports.js";
import { errorKindOf, stepError } from "../../core/errors.js";
import type {
  Evidence,
  PageElement,
  SettleOptions,
  SnapshotOptions,
  Target,
} from "../../core/types.js";
import { PerceptionObservation, assertDecisionCurrent, decisionReference } from "../../core/observation.js";
import { decisionToStep, describeAmbiguity, type Decision, type ActionPolicy } from "../../core/discover/decision.js";
import { ACTION_RULES } from "../../core/discover/prompt.js";
import { redactSecrets, slotSecretText, type Secrets } from "../../core/secrets.js";
import { extractFirstJsonObject } from "../../core/json.js";

/** A recorded substitution: `original` could not be found, `healed` (a re-located target carrying
 * role/index, not a brittle text-only one) was used instead. */
export interface Heal {
  original: Target;
  healed: Target;
  reason?: string;
}

export interface SelfHealOptions {
  /** Maximum repair model requests, including unsuccessful attempts. Defaults to 5. */
  maxHeals?: number;
  policy?: ActionPolicy;
  perceive?: PerceptionAdapter;
  /** Mask configured input values in the repair prompt and policy context. */
  secrets?: Secrets;
  /** Fired when a step is healed — a host's signal that the scenario is aging (re-freeze worthwhile). */
  onHeal?: (heal: Heal) => void;
}

const HEAL_SYSTEM =
  ACTION_RULES +
  "You repair a broken browser test step. A step needs to act on an element described by " +
  "the original target, but no element with that name exists on the page now. Choose the " +
  "CURRENT element that best fulfills the original intent, or none if nothing fits. " +
  'Respond with strict JSON, no prose, no code fences: {"name":"<exact current element name>"} ' +
  'or {"ref":"<current reference>"}, with optional role/nth for legacy names, or {"name":null}.';

function healPrompt(target: Target, page: PerceptionObservation): string {
  return [
    `Original target: ${target.text ?? target.selector ?? "(unknown)"}`,
    `Current interactive elements:`,
    page.render || "(none)",
    page.references,
    `Which current element best matches the original target? JSON only.`,
  ].join("\n");
}

/** Parse the heal reply → a chosen element name, or undefined for "none". */
export function parseHealChoice(text: string): string | undefined {
  const obj = extractFirstJsonObject(text) as { name?: unknown } | undefined;
  if (!obj) throw new Error(`no JSON in heal reply: ${text.slice(0, 200)}`);
  return typeof obj.name === "string" && obj.name.trim() ? obj.name : undefined;
}

export class SelfHealingDriver implements Driver {
  readonly heals: Heal[] = [];
  private healAttempts = 0;
  private readonly maxHeals: number;
  private readonly onHeal?: (heal: Heal) => void;

  constructor(
    private readonly inner: Driver,
    private readonly llm: LlmClient,
    private readonly opts: SelfHealOptions = {},
  ) {
    this.maxHeals = opts.maxHeals ?? 5;
    this.onHeal = opts.onHeal;
    if (inner.locateRef) this.locateRef = ref => inner.locateRef!(ref);
  }

  async goto(url: string): Promise<void> {
    return this.inner.goto(url);
  }

  locateRef?: (ref: string) => Promise<Target>;

  async click(target: Target, ref?: string): Promise<void> {
    return this.act(target, ref, "click", (t, r) => this.inner.click(t, r));
  }

  async doubleClick(target: Target, ref?: string): Promise<void> {
    return this.act(target, ref, "doubleClick", (t, r) => this.inner.doubleClick(t, r));
  }

  async hover(target: Target, ref?: string): Promise<void> {
    return this.act(target, ref, "hover", (t, r) => this.inner.hover(t, r));
  }

  async type(target: Target, text: string, ref?: string): Promise<void> {
    return this.act(target, ref, "type", (t, r) => this.inner.type(t, text, r), text);
  }

  async select(target: Target, value: string, ref?: string): Promise<void> {
    return this.act(target, ref, "select", (t, r) => this.inner.select(t, value, r), value);
  }

  private async act(target: Target, ref: string | undefined, action: Decision["action"], dispatch: (target: Target, ref?: string) => Promise<void>, value?: string): Promise<void> {
    try {
      await dispatch(target, ref);
    } catch (cause) {
      // A selected node disappearing never authorizes a substitute; re-decide on a fresh page.
      if (ref !== undefined) throw cause;
      const repaired = await this.heal(target, cause, action, value);
      repaired.validate();
      await dispatch(repaired.heal.healed, repaired.ref);
      this.heals.push(repaired.heal);
      this.onHeal?.(repaired.heal);
    }
  }

  locate(target: Target): Promise<Target> {
    return this.inner.locate(target);
  }

  pressKey(key: string): Promise<void> {
    return this.inner.pressKey(key);
  }

  scroll(direction?: "down" | "up"): Promise<void> {
    return this.inner.scroll(direction);
  }

  screenshot(): Promise<string | undefined> {
    return this.inner.screenshot();
  }

  snapshot(options?: SnapshotOptions): Promise<PageElement[]> {
    return this.inner.snapshot(options);
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

  private assertHealBudget(target: Target, cause: unknown): void {
    if (this.healAttempts >= this.maxHeals) {
      throw stepError(
        errorKindOf(cause) ?? "resolution",
        `self-heal budget (${this.maxHeals}) exhausted for ${JSON.stringify(target)}`,
      );
    }
  }

  private async heal(target: Target, cause: unknown, action: Decision["action"], value?: string): Promise<{ heal: Heal; ref?: string; validate: () => void }> {
    this.assertHealBudget(target, cause);
    const raw = await this.inner.snapshot({ perception: true });
    const elements = redactSecrets(this.opts.perceive ? await this.opts.perceive(raw.map(e => ({ ...e }))) : raw, this.opts.secrets);
    const page = new PerceptionObservation(this.inner, raw, elements, target.text ?? target.selector ?? "");
    // Observation may yield to another repair. Reserve a request only after it succeeds,
    // and keep this check and increment synchronous so concurrent calls share the limit.
    this.assertHealBudget(target, cause);
    this.healAttempts++;
    const reply = await this.llm.complete(healPrompt(target, page), {
      system: HEAL_SYSTEM,
    });
    const parsed = extractFirstJsonObject(reply) as { name?: string; ref?: string; role?: string; nth?: number } | undefined;
    const choice = parseHealChoice(reply);
    if (!choice && parsed?.ref === undefined) {
      const why = cause instanceof Error ? cause.message : String(cause);
      // The original cause keeps its kind: a transport failure healed into nothing is still transport.
      throw stepError(
        errorKindOf(cause) ?? "resolution",
        `self-heal found no match for ${JSON.stringify(target)} (${why})`,
      );
    }
    const decision = page.bind({ action, ...(choice ? { text: choice } : {}),
      ...(parsed?.ref !== undefined ? { ref: parsed.ref } : {}),
      ...(parsed?.role !== undefined ? { role: parsed.role } : {}),
      ...(parsed?.nth !== undefined ? { nth: parsed.nth } : {}), ...(value !== undefined ? { value: slotSecretText(value, this.opts.secrets) } : {}) });
    const ambiguity = describeAmbiguity(decision, elements);
    if (ambiguity) throw stepError("resolution", ambiguity);
    if (this.opts.policy) {
      const evidence = await this.inner.observe();
      const verdict = this.opts.policy.vet(decision, { elements, url: evidence.execution.finalUrl });
      if (!verdict.ok) throw stepError("resolution", `heal blocked by policy: ${verdict.reason}`);
    }
    const ref = decisionReference(this.inner, decision);
    const step = await decisionToStep(this.inner, decision);
    if (!("target" in step)) throw stepError("resolution", "heal did not choose a target");
    return { heal: { original: target, healed: step.target }, ref, validate: () => assertDecisionCurrent(this.inner, decision) };
  }
}
