import type { Driver, LlmClient } from "./ports.js";
import type { Evidence, ExecutedAction, LlmUsage, Result, RunUsage, Verdict } from "./types.js";
import { emptyUsage } from "./usage.js";
import { combineSignals } from "./abort.js";

// Host extensions may carry non-cloneable values (for example custom step params). Evidence
// capture must never throw from the deadline timer or turn an execution stop into a crash.
function snapshot<T>(value: T): T {
  try { return structuredClone(value); }
  catch { return value; }
}

/** Runtime controls, never part of a frozen scenario or judgment identity. */
export interface RunBudget {
  maxModelCalls?: number;
  timeoutMs?: number;
}

export interface BudgetExhaustion {
  limit: "model-calls" | "time";
  configured: RunBudget;
  modelCalls: number;
  elapsedMs: number;
  phase: string;
  /** An operation dispatched before the stop; its effects must not be retried blindly. */
  operation?: { name: string; outcome: "unknown" };
}

export class BudgetExceededError extends Error {
  override readonly name = "BudgetExceededError";
  constructor(readonly budget: BudgetExhaustion, readonly evidence?: Evidence, readonly usage?: RunUsage) {
    super(`Run budget exhausted: ${budget.limit} during ${budget.phase}`);
  }
}

export function validateRunBudget(value: RunBudget | undefined): RunBudget | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("budget must be an object");
  const out: RunBudget = {};
  for (const key of ["maxModelCalls", "timeoutMs"] as const) {
    const n = value[key];
    if (n === undefined) continue;
    if (!Number.isSafeInteger(n) || n < 0 || (key === "timeoutMs" && n > 2_147_483_647))
      throw new Error(`budget.${key} must be a nonnegative safe integer${key === "timeoutMs" ? " <= 2147483647" : ""}`);
    out[key] = n;
  }
  return out;
}

/** Internal propagation: nested phases borrow the owner; only the owner disposes it. */
export const budgetScope = Symbol("run-budget");
export interface BudgetOptions {
  budget?: RunBudget;
  signal?: AbortSignal;
  [budgetScope]?: BudgetScope;
}

export class BudgetScope {
  readonly limits: RunBudget;
  readonly signal: AbortSignal;
  phase = "prepare";
  modelCalls = 0;
  evidence?: Evidence;
  private readonly actions: ExecutedAction[] = [];
  private readonly usage = emptyUsage();
  private readonly controller = new AbortController();
  private readonly started = performance.now();
  private readonly timer?: ReturnType<typeof setTimeout>;
  private failure?: BudgetExceededError;
  private readonly pending = new Map<symbol, { name: string; settled: Promise<void> }>();
  private readonly drivers = new WeakMap<Driver, Driver>();
  private readonly onAbort: () => void;

  constructor(limits: RunBudget, private readonly caller?: AbortSignal) {
    this.limits = validateRunBudget(limits)!;
    this.signal = this.controller.signal;
    this.onAbort = () => { if (!this.signal.aborted) this.controller.abort(caller?.reason); };
    caller?.addEventListener("abort", this.onAbort, { once: true });
    if (caller?.aborted) this.onAbort();
    if (this.limits.timeoutMs !== undefined)
      this.timer = setTimeout(() => { if (!this.signal.aborted) this.exhaust("time"); }, this.limits.timeoutMs);
  }

  private exhaust(limit: BudgetExhaustion["limit"]): BudgetExceededError {
    if (!this.failure) {
      const operation = [...this.pending.values()].at(-1)?.name;
      this.failure = new BudgetExceededError({ limit, configured: { ...this.limits },
        modelCalls: this.modelCalls, elapsedMs: Math.max(0, performance.now() - this.started), phase: this.phase,
        ...(operation ? { operation: { name: operation, outcome: "unknown" as const } } : {}),
      }, this.recordedEvidence(), { ...this.usage, llmCalls: this.modelCalls });
      this.controller.abort(this.failure);
    }
    return this.failure;
  }

  check(): void {
    if (this.failure) throw this.failure;
    this.signal.throwIfAborted();
    if (this.limits.timeoutMs !== undefined && performance.now() - this.started >= this.limits.timeoutMs)
      throw this.exhaust("time");
  }

  reserve(): void {
    this.check();
    if (this.limits.maxModelCalls !== undefined && this.modelCalls >= this.limits.maxModelCalls)
      throw this.exhaust("model-calls");
    this.modelCalls++;
  }

  recordAction(action: ExecutedAction): number { return this.actions.push(snapshot(action)) - 1; }

  updateAction(index: number, action: ExecutedAction): void { this.actions[index] = snapshot(action); }

  recordUsage(usage: LlmUsage): void {
    this.usage.measuredCalls++;
    this.usage.inputTokens += usage.inputTokens ?? 0;
    this.usage.outputTokens += usage.outputTokens ?? 0;
    this.usage.cacheReadTokens += usage.cacheReadTokens ?? 0;
  }

  private recordedEvidence(): Evidence | undefined {
    if (!this.evidence && !this.actions.length) return undefined;
    const evidence = this.evidence ?? { execution: { actions: [], navigated: false, blocked: true },
      perception: {}, logic: { requests: [], console: [] } };
    return snapshot({ ...evidence, execution: { ...evidence.execution,
      actions: this.actions.length ? [...this.actions] : [...evidence.execution.actions], blocked: true } });
  }

  /** Cooperative: await settlement, then reject late values. Never leave an orphaned action. */
  async operation<T>(name: string, run: () => Promise<T>): Promise<T> {
    this.check();
    const token = Symbol(name);
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    this.pending.set(token, { name, settled });
    try {
      const value = await run();
      this.check();
      return value;
    } catch (error) {
      this.check();
      throw error;
    } finally {
      this.pending.delete(token);
      settle();
    }
  }

  /** A sibling may reject Promise.all before already admitted work settles. Only the owner drains. */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending.values()].map(operation => operation.settled));
  }

  llm(inner: LlmClient, phase?: string): LlmClient {
    const scope = this;
    return {
      get id() { return inner.id; },
      async complete(prompt, options) {
        if (phase) scope.phase = phase;
        scope.reserve();
        const combined = combineSignals(options?.signal ? [scope.signal, options.signal] : [scope.signal]);
        try { return await scope.operation("model.complete", () => inner.complete(prompt, {
          ...options, signal: combined.signal,
          onUsage: usage => {
            scope.recordUsage(usage);
            options?.onUsage?.(usage);
          },
        })); } finally { combined.dispose(); }
      },
    };
  }

  driver(inner: Driver): Driver {
    const existing = this.drivers.get(inner);
    if (existing) return existing;
    const scope = this;
    // A separate target permits decorating frozen/non-configurable host methods. Invoke on the
    // original receiver so class private fields and optional capabilities keep working.
    const wrapped = new Proxy({} as Driver, { get(_target, key) {
      const value = Reflect.get(inner, key, inner);
      if (typeof value !== "function") return value;
      if (key === "close") return value.bind(inner); // cleanup must remain possible after expiry
      return (...args: unknown[]) => scope.operation(`driver.${String(key)}`, async () => {
        const result = await value.apply(inner, args);
        if (key === "observe" && !scope.signal.aborted) scope.evidence = snapshot(result as Evidence);
        return result;
      });
    }, has: (_target, key) => key in inner });
    this.drivers.set(inner, wrapped);
    this.drivers.set(wrapped, wrapped);
    return wrapped;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.caller?.removeEventListener("abort", this.onAbort);
  }
}

export function budgetVerdict(error: BudgetExceededError): Verdict {
  return { passed: false, results: [], failure: "budget", detail: error.message, budget: error.budget };
}

export function budgetResult(task: string, error: BudgetExceededError): Result {
  return { scenario: task, context: { intent: task }, verdict: budgetVerdict(error),
    evidence: error.evidence ?? { execution: { actions: [], navigated: false, blocked: true },
      perception: {}, logic: { requests: [], console: [] } },
    usage: error.usage ?? { ...emptyUsage(), llmCalls: error.budget.modelCalls },
  };
}

export function rethrowBudget(error: unknown): void {
  if (error instanceof BudgetExceededError) throw error;
}

export async function withBudget<T, O extends BudgetOptions>(opts: O, phase: string,
  run: (options: O, scope: BudgetScope | undefined) => Promise<T>): Promise<T> {
  const shared = opts[budgetScope];
  const limits = shared ? undefined : validateRunBudget(opts.budget);
  const scope = shared ?? (limits ? new BudgetScope(limits, opts.signal) : undefined);
  if (!scope) return run(opts, undefined);
  const previous = scope.phase;
  scope.phase = phase;
  try {
    scope.check();
    const result = await run({ ...opts, signal: scope.signal, [budgetScope]: scope }, scope);
    if (!shared) await scope.drain();
    scope.check();
    return result;
  } catch (error) {
    if (!shared) await scope.drain();
    scope.check();
    throw error;
  } finally {
    scope.phase = previous;
    if (!shared) scope.dispose();
  }
}
