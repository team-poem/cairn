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
  /** Borrow a `runWorkflow` allowance instead of owning one. The workflow owns the limits and the
   * cancellation signal, so `budget` and `signal` must be omitted. One engine operation per lease. */
  workflow?: WorkflowLease;
  [budgetScope]?: BudgetScope;
}

type Facts = Omit<BudgetExhaustion, "phase" | "operation">;
type OperationOwner = "engine" | "workflow";

/** What an owner shares with every borrower: one allowance, one deadline, one signal.
 * Lifecycle: open, then draining once the owner admits no more work, then closed. Exhaustion
 * (`failure`) can happen while open and is never undone. */
export class Allowance {
  modelCalls = 0;
  failure?: BudgetExceededError;
  stage: "open" | "draining" | "closed" = "open";
  readonly signal: AbortSignal;
  readonly pending = new Map<symbol, { name: string; settled: Promise<void>; scope: BudgetScope; owner: OperationOwner }>();
  /** Whole borrowed calls, including cleanup and publication after their final port operation. */
  readonly entries = new Map<symbol, Promise<void>>();
  drainError?: { error: unknown };
  readonly scopes: BudgetScope[] = [];
  /** Wrapper to raw client or driver, so work already managed here is never admitted twice. */
  readonly managed = new WeakMap<object, object>();
  private readonly controller = new AbortController();
  private readonly started = performance.now();
  private readonly timer?: ReturnType<typeof setTimeout>;
  private readonly onAbort: () => void;

  constructor(readonly limits: RunBudget, private readonly caller?: AbortSignal) {
    this.signal = this.controller.signal;
    this.onAbort = () => { if (!this.signal.aborted) this.controller.abort(caller?.reason); };
    caller?.addEventListener("abort", this.onAbort, { once: true });
    if (caller?.aborted) this.onAbort();
    if (limits.timeoutMs !== undefined)
      this.timer = setTimeout(() => { if (!this.signal.aborted) this.exhaust("time"); }, limits.timeoutMs);
  }

  elapsedMs(): number { return Math.max(0, performance.now() - this.started); }

  expired(): boolean { return this.limits.timeoutMs !== undefined && this.elapsedMs() >= this.limits.timeoutMs; }

  /** Each busy scope keeps its own stop record. The aggregate blames the scope that hit the
   * limit, else the one with the latest in-flight operation, else the most recent scope. */
  exhaust(limit: BudgetExhaustion["limit"], by?: BudgetScope): void {
    if (this.failure) return;
    const facts: Facts = { limit, configured: { ...this.limits }, modelCalls: this.modelCalls, elapsedMs: this.elapsedMs() };
    const blamed = by ?? [...this.pending.values()].at(-1)?.scope ?? this.scopes.at(-1);
    for (const scope of this.scopes) if (scope === blamed || scope.busy()) scope.stop(facts);
    this.failure = blamed?.stopped() ?? new BudgetExceededError({ ...facts, phase: "workflow" });
    this.controller.abort(this.failure);
  }

  assertOpen(completing = false): void {
    if (this.failure) throw this.failure;
    if (this.stage !== "open" && !(completing && this.stage === "draining"))
      throw new Error("workflow budget is closed and admits no new work");
    this.signal.throwIfAborted();
  }

  /** Observe the exact promise returned to a borrower, even if its caller stops awaiting it. */
  observe<T>(promise: Promise<T>): Promise<T> {
    void promise.catch(error => {
      if (this.stage === "draining") this.drainError ??= { error };
    });
    return promise;
  }

  async drain(scope?: BudgetScope): Promise<void> {
    const left = () => [
      ...[...this.pending.values()].filter(operation => !scope ||
        (operation.scope === scope && operation.owner === "engine")).map(operation => operation.settled),
      ...(!scope ? this.entries.values() : []),
    ];
    for (let pending = left(); pending.length; pending = left()) await Promise.all(pending);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.caller?.removeEventListener("abort", this.onAbort);
  }
}

/** One accounting view of an allowance: an owned run, or one participant of a workflow. */
export class BudgetScope {
  readonly allowance: Allowance;
  phase = "prepare";
  /** Admissions this scope reserved. For an owned run this is also the allowance total. */
  modelCalls = 0;
  evidence?: Evidence;
  /** Inside the entry point that owns or borrows this scope; attributes a stop to it. */
  active = false;
  /** A workflow lease enters at most one engine operation. */
  entered = false;
  private readonly actions: ExecutedAction[] = [];
  private readonly usage = emptyUsage();
  private readonly drivers: Record<OperationOwner, WeakMap<Driver, Driver>> = {
    engine: new WeakMap(), workflow: new WeakMap(),
  };
  private failure?: BudgetExceededError;

  constructor(source: RunBudget | Allowance, caller?: AbortSignal, readonly participant?: string) {
    this.allowance = source instanceof Allowance ? source : new Allowance(validateRunBudget(source)!, caller);
    this.allowance.scopes.push(this);
  }

  get limits(): RunBudget { return this.allowance.limits; }
  get signal(): AbortSignal { return this.allowance.signal; }

  busy(): boolean { return this.active || [...this.allowance.pending.values()].some(operation => operation.scope === this); }

  stopped(): BudgetExceededError | undefined { return this.failure; }

  stop(facts: Facts): void {
    const operation = [...this.allowance.pending.values()].filter(pending => pending.scope === this).at(-1)?.name;
    this.failure = new BudgetExceededError({ ...facts, phase: this.phase,
      ...(operation ? { operation: { name: operation, outcome: "unknown" as const } } : {}),
    }, this.recordedEvidence(), this.report());
  }

  report(): RunUsage { return { ...this.usage, llmCalls: this.modelCalls }; }

  check(completing = false): void {
    if (this.failure) throw this.failure;
    this.allowance.assertOpen(completing);
    if (this.allowance.expired()) {
      this.allowance.exhaust("time", this);
      throw this.failure ?? this.allowance.failure!;
    }
  }

  reserve(): void {
    this.check();
    const { limits } = this.allowance;
    if (limits.maxModelCalls !== undefined && this.allowance.modelCalls >= limits.maxModelCalls) {
      this.allowance.exhaust("model-calls", this);
      throw this.failure ?? this.allowance.failure!;
    }
    this.allowance.modelCalls++;
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
  operation<T>(name: string, run: () => Promise<T>, owner: OperationOwner = "engine"): Promise<T> {
    return this.allowance.observe((async () => {
      this.check();
      const token = Symbol(name);
      let settle!: () => void;
      const settled = new Promise<void>(resolve => { settle = resolve; });
      this.allowance.pending.set(token, { name, settled, scope: this, owner });
      try {
        const value = await run();
        this.check(true);
        return value;
      } catch (error) {
        this.check(true);
        throw error;
      } finally {
        this.allowance.pending.delete(token);
        settle();
      }
    })());
  }

  /** A sibling may reject Promise.all before already admitted work settles. Only an entry drains. */
  drain(): Promise<void> { return this.allowance.drain(this); }

  /** The raw client or driver behind a wrapper this allowance already manages. */
  unwrap<T extends object>(value: T): T { return (this.allowance.managed.get(value) as T | undefined) ?? value; }

  llm(client: LlmClient, phase?: string, owner: OperationOwner = "engine"): LlmClient {
    const inner = this.unwrap(client);
    const scope = this;
    const wrapped: LlmClient = {
      get id() { return inner.id; },
      complete(prompt, options) {
        return scope.allowance.observe((async () => {
          if (phase) scope.phase = phase;
          scope.reserve();
          const combined = combineSignals(options?.signal ? [scope.signal, options.signal] : [scope.signal]);
          try { return await scope.operation("model.complete", () => inner.complete(prompt, {
            ...options, signal: combined.signal,
            onUsage: usage => {
              scope.recordUsage(usage);
              options?.onUsage?.(usage);
            },
          }), owner); } finally { combined.dispose(); }
        })());
      },
    };
    this.allowance.managed.set(wrapped, inner);
    return wrapped;
  }

  driver(driver: Driver, owner: OperationOwner = "engine"): Driver {
    const inner = this.unwrap(driver);
    const existing = this.drivers[owner].get(inner);
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
      }, owner);
    }, has: (_target, key) => key in inner });
    this.drivers[owner].set(inner, wrapped);
    this.allowance.managed.set(wrapped, inner);
    return wrapped;
  }

  dispose(): void { this.allowance.dispose(); }
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

const leases = new WeakMap<WorkflowLease, BudgetScope>();

/** Track the complete public call separately from its port operations: an entry drains its
 * own ports, while only the workflow owner waits for entry cleanup and trace publication. */
export function withWorkflowEntry<T>(opts: BudgetOptions, run: () => Promise<T>): Promise<T> {
  const scope = !opts[budgetScope] && opts.workflow ? leases.get(opts.workflow) : undefined;
  if (!scope) return run();
  return scope.allowance.observe((async () => {
    scope.allowance.assertOpen();
    const token = Symbol("workflow-entry");
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    scope.allowance.entries.set(token, settled);
    try { return await run(); }
    finally {
      scope.allowance.entries.delete(token);
      settle();
    }
  })());
}

function borrowed(opts: BudgetOptions): BudgetScope | undefined {
  if (opts.workflow === undefined) return undefined;
  const scope = leases.get(opts.workflow);
  if (!scope) throw new Error("workflow must be a lease from runWorkflow");
  if (opts.budget !== undefined || opts.signal !== undefined)
    throw new Error("a workflow lease owns the budget and signal; omit budget and signal");
  if (scope.entered) throw new Error(`workflow lease "${scope.participant}" already served an engine operation; borrow another`);
  scope.entered = true;
  return scope;
}

export async function withBudget<T, O extends BudgetOptions>(opts: O, phase: string,
  run: (options: O, scope: BudgetScope | undefined) => Promise<T>): Promise<T> {
  const nested = opts[budgetScope];
  const lease = nested ? undefined : borrowed(opts);
  const limits = nested || lease ? undefined : validateRunBudget(opts.budget);
  const scope = nested ?? lease ?? (limits ? new BudgetScope(limits, opts.signal) : undefined);
  if (!scope) return run(opts, undefined);
  const previous = scope.phase;
  scope.phase = phase;
  if (!nested) scope.active = true;
  try {
    scope.check();
    const result = await run({ ...opts, signal: scope.signal, [budgetScope]: scope }, scope);
    if (!nested) await scope.drain();
    scope.check();
    return result;
  } catch (error) {
    if (!nested) await scope.drain();
    scope.check();
    throw error;
  } finally {
    scope.phase = previous;
    if (!nested) scope.active = false;
    if (!nested && !lease) scope.dispose();
  }
}

/** One participant of a workflow. Pass it as `workflow` to exactly one engine operation, and
 * register host-owned model and browser work through it. Unregistered work is not covered. */
export interface WorkflowLease {
  readonly name: string;
  /** The owner's signal: aborted on exhaustion or on the owner's caller cancellation. */
  readonly signal: AbortSignal;
  /** Reserve one admission before each completion. A client this workflow already manages is
   * unwrapped first, so passing a lease client to an engine operation is counted once. */
  llm(client: LlmClient): LlmClient;
  /** Check the deadline around every driver call; `close` stays available after exhaustion. */
  driver(driver: Driver): Driver;
  /** Run host work (a browser mutation, a store write) under the deadline. It is awaited on
   * expiry, its late result is rejected, and it is never retried. */
  operation<T>(name: string, run: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

export interface Workflow {
  readonly signal: AbortSignal;
  /** A new participant. Refused once the allowance is exhausted or the workflow is closing. */
  borrow(name: string): WorkflowLease;
}

export interface WorkflowOptions {
  budget: RunBudget;
  /** Caller cancellation. It rejects `runWorkflow` with its reason, distinct from exhaustion. */
  signal?: AbortSignal;
}

export interface WorkflowParticipant {
  name: string;
  /** Admissions this participant reserved; participants sum to the aggregate count. */
  modelCalls: number;
  usage: RunUsage;
  /** Present when the stop interrupted this participant: where, what is uncertain, partial evidence. */
  stop?: { phase: string; operation?: BudgetExhaustion["operation"]; evidence?: Evidence };
}

export type WorkflowOutcome<T> =
  | { status: "completed"; value: T; modelCalls: number; elapsedMs: number; participants: WorkflowParticipant[] }
  /** Not an application failure and not partial success: no value is returned. */
  | { status: "exhausted"; budget: BudgetExhaustion; participant?: string; participants: WorkflowParticipant[] };

/** Own one allowance, deadline and cancellation signal for host-composed work. Engine
 * operations and registered host work borrow it; the owner drains every admitted operation,
 * releases its timer and listener exactly once, then returns the outcome. */
export async function runWorkflow<T>(options: WorkflowOptions, work: (workflow: Workflow) => Promise<T>): Promise<WorkflowOutcome<T>> {
  const allowance = new Allowance(validateRunBudget(options.budget) ?? {}, options.signal);
  const workflow: Workflow = {
    signal: allowance.signal,
    borrow(name) {
      if (typeof name !== "string" || !name.trim()) throw new Error("a workflow participant needs a name");
      allowance.assertOpen();
      const scope = new BudgetScope(allowance, undefined, name);
      scope.phase = "host";
      const lease: WorkflowLease = Object.freeze({
        name,
        signal: allowance.signal,
        llm: (client: LlmClient) => scope.llm(client, undefined, "workflow"),
        driver: (driver: Driver) => scope.driver(driver, "workflow"),
        operation: <R>(operation: string, run: (signal: AbortSignal) => Promise<R>) =>
          scope.operation(operation, () => run(allowance.signal), "workflow"),
      });
      leases.set(lease, scope);
      return lease;
    },
  };
  let outcome: { value: T } | { error: unknown };
  try {
    allowance.assertOpen();
    outcome = { value: await work(workflow) };
  } catch (error) {
    outcome = { error };
  }
  if (!allowance.signal.aborted && allowance.expired()) allowance.exhaust("time");
  allowance.stage = "draining";
  try { await allowance.drain(); }
  finally {
    allowance.stage = "closed";
    allowance.dispose();
  }
  const participants = allowance.scopes.map((scope): WorkflowParticipant => {
    const stopped = scope.stopped();
    return { name: scope.participant!, modelCalls: scope.modelCalls, usage: scope.report(),
      ...(stopped ? { stop: { phase: stopped.budget.phase,
        ...(stopped.budget.operation ? { operation: stopped.budget.operation } : {}),
        ...(stopped.evidence ? { evidence: stopped.evidence } : {}) } } : {}) };
  });
  const failure = allowance.failure;
  if (failure) {
    const blamed = allowance.scopes.find(scope => scope.stopped() === failure)?.participant;
    return { status: "exhausted", budget: failure.budget, ...(blamed ? { participant: blamed } : {}), participants };
  }
  if (allowance.signal.aborted) throw allowance.signal.reason;
  if ("error" in outcome) throw outcome.error;
  if (allowance.drainError) throw allowance.drainError.error;
  return { status: "completed", value: outcome.value, modelCalls: allowance.modelCalls, elapsedMs: allowance.elapsedMs(), participants };
}
