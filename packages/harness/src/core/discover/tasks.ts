import type { PerceptionObservation } from "../observation.js";
import type { PageElement, Step, TargetAction } from "../types.js";
import type { Decision, PolicyContext } from "./decision.js";

export interface DiscoveryTaskAssessment {
  /** Reaching a target and verifying its contents are independent observations. */
  route: "completed" | "unavailable";
  verification: "passed" | "failed" | "unknown";
}

/** Each task authorizes at most one confirmed action. Declare a multi-action route as distinct tasks. */
export interface DiscoveryTaskPlan {
  tasks: readonly { id: string; instruction: string }[];
  ordered?: boolean;
  /** Continue only when the remaining tasks are independent of the failed or unavailable one. */
  onFailure: "stop" | "continue";
  /** Early done decisions allowed without route progress before the next one stops the run. Default 2. */
  maxEarlyDone?: number;
  /** Identify the task or return undefined. Called for the proposed action and again on a fresh
   * observation before dispatch; do not consume tasks or mutate host state here. */
  match(decision: Readonly<Decision>, observation: Readonly<PolicyContext>): string | undefined;
  /** Synchronous host check on a fresh observation after the driver acknowledged the step. */
  assess(taskId: string, step: Readonly<Step>, observation: Readonly<PolicyContext>): DiscoveryTaskAssessment;
}

type TaskStop = "task-failed" | "task-unavailable" | "early-done-limit";
export type DiscoveryTaskStopReason = TaskStop | "tasks-complete" | "policy-stop"
  | "step-limit" | "engine-stopped" | "dispatch-uncertain";

type TaskStatus = {
  id: string;
  /** Unconfirmed means input may have been sent or the step has not yet been assessed. Never retry it. */
  route: "pending" | "unconfirmed" | DiscoveryTaskAssessment["route"];
  verification: DiscoveryTaskAssessment["verification"];
};

/** Discovery-only report. An observed verification result is not a replay assertion. */
export interface DiscoveryTaskReport {
  reason: DiscoveryTaskStopReason;
  modelDoneCount: number;
  tasks: TaskStatus[];
  completed: string[];
  /** All routes not confirmed completed, including unavailable and unconfirmed tasks. */
  remaining: string[];
}

const validId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** Called after page.bind. A task instruction is not a locator or permission to invent a URL. */
export function taskDecisionGrounded(decision: Decision, listed: PerceptionObservation["listed"], raw: readonly PageElement[],
  allowLegacyOrdinal: boolean, options: { boundRef?: string; expectedRole?: string; hasRefPort: boolean; requiresExact: boolean; scoped: boolean }): boolean {
  switch (decision.action) {
    case "pressKey": case "scroll": case "waitFor": return true;
    case "click": case "doubleClick": case "type": case "hover": case "select": break;
    default: return false;
  }
  const { text, role, nth } = decision;
  if (typeof text !== "string" || !text.trim()) return false;
  if (nth !== undefined && ((!allowLegacyOrdinal && !options.boundRef) || !role || !Number.isSafeInteger(nth) || nth < 0)) return false;
  const name = text.trim().toLowerCase();
  const matches = raw.filter(e => (role === undefined || e.role === role) && e.name.trim().toLowerCase() === name);
  const exact = matches[nth ?? 0];
  if (!exact || (nth === undefined && matches.length !== 1) || exact.name !== text || exact.role !== options.expectedRole) return false;
  const disallowed = (row: PageElement) => row.actions && Object.hasOwn(row.actions, decision.action)
    && row.actions[decision.action as TargetAction] === "disallowed";
  if (disallowed(exact)) return false;
  if (!options.scoped) {
    if (options.boundRef !== undefined) {
      if (exact.ref !== options.boundRef) return false; // never rebind by role/name after a new snapshot
    } else if (options.requiresExact || (exact.ref && options.hasRefPort)) return false;
  }
  // An ordinal is a full-snapshot ordinal, not an index into the shorter ranked listing.
  return listed.some(({element, nth: ordinal}) => element.name === text && element.role === exact.role && ordinal === nth
    && (!exact.ref || !options.hasRefPort || element.ref === exact.ref) && !disallowed(element));
}

/** Owned by a single discovery invocation. Model statements never update route or verification. */
export class DiscoveryTaskRun {
  private readonly tasks = new Map<string, TaskStatus & { instruction: string }>();
  private readonly ordered: boolean;
  private readonly onFailure: DiscoveryTaskPlan["onFailure"];
  private readonly maxEarlyDone: number;
  private readonly match: DiscoveryTaskPlan["match"];
  private readonly assess: DiscoveryTaskPlan["assess"];
  private awaiting?: { id: string; step: Step };
  private doneCount = 0;
  private earlyWithoutProgress = 0;

  constructor(plan: DiscoveryTaskPlan) {
    if (!plan || !Array.isArray(plan.tasks) || !plan.tasks.length || plan.tasks.length > 32)
      throw new TypeError("a discovery task plan requires 1 to 32 tasks");
    if (typeof plan.match !== "function" || typeof plan.assess !== "function"
      || !["stop", "continue"].includes(plan.onFailure)
      || (plan.ordered !== undefined && typeof plan.ordered !== "boolean"))
      throw new TypeError("a discovery task plan requires match, assess and an explicit onFailure policy");
    this.maxEarlyDone = plan.maxEarlyDone === undefined ? 2 : plan.maxEarlyDone;
    if (!Number.isSafeInteger(this.maxEarlyDone) || this.maxEarlyDone < 0 || this.maxEarlyDone > 16)
      throw new RangeError("maxEarlyDone must be an integer from 0 to 16");
    this.ordered = plan.ordered ?? false;
    this.onFailure = plan.onFailure;
    this.match = plan.match.bind(plan);
    this.assess = plan.assess.bind(plan);
    for (const task of plan.tasks) {
      if (!task || typeof task.id !== "string" || !validId.test(task.id) || this.tasks.has(task.id))
        throw new TypeError("discovery tasks require distinct bounded IDs");
      if (typeof task.instruction !== "string" || !task.instruction.trim() || task.instruction.length > 256)
        throw new TypeError("each discovery task instruction must contain 1 to 256 characters");
      this.tasks.set(task.id, { id: task.id, instruction: task.instruction, route: "pending", verification: "unknown" });
    }
  }

  get needsAssessment(): boolean { return this.awaiting !== undefined; }
  get hasPendingWork(): boolean { return this.pending().length !== 0; }
  private pending() { return [...this.tasks.values()].filter(task => task.route === "pending"); }
  private eligible() {
    const pending = this.pending();
    return this.ordered ? pending.slice(0, 1) : pending;
  }

  prompt(renderText: (text: string) => string = text => text): string {
    // Slot secret values before JSON escaping can split them (e.g. quotes and newlines).
    const tasks = this.eligible().map(({ id, instruction }) => ({ id: renderText(id), instruction: renderText(instruction) }));
    return "Remaining host tasks eligible for the next action: " + JSON.stringify(tasks)
      + "\nChoose an action on the current observation; do not repeat an earlier task or invent a URL.";
  }

  authorize(decision: Decision, ctx: PolicyContext): string | undefined {
    if (this.needsAssessment || this.stopReason() || decision.action === "done") return undefined;
    // A host callback must not change the already-vetted decision or its bound observation.
    const id = this.match(structuredClone(decision), structuredClone(ctx));
    return this.eligible().some(task => task.id === id) ? id : undefined;
  }

  executed(id: string, step: Step): void {
    const task = this.tasks.get(id);
    if (this.awaiting || task?.route !== "pending") throw new Error("a discovery task can execute only once");
    task.route = "unconfirmed";
    this.awaiting = { id, step: structuredClone(step) };
  }

  observe(ctx: PolicyContext): void {
    if (!this.awaiting) return;
    const { id, step } = this.awaiting;
    this.awaiting = undefined;
    const task = this.tasks.get(id)!;
    const result = this.assess(id, step, structuredClone(ctx));
    if (!result || !["completed", "unavailable"].includes(result.route)
      || !["passed", "failed", "unknown"].includes(result.verification))
      throw new TypeError("assess must return a discovery task route and verification status");
    task.route = result.route;
    task.verification = result.verification;
    if (task.route === "completed") this.earlyWithoutProgress = 0;
  }

  uncertain(id: string): void {
    const task = this.tasks.get(id);
    if (task?.route !== "pending") throw new Error("uncertain dispatch must identify a pending task");
    task.route = "unconfirmed";
  }

  /** Called only while there are pending tasks; a final confirmed task needs no new decision. */
  canContinueAfterDone(): boolean {
    this.doneCount++;
    return ++this.earlyWithoutProgress <= this.maxEarlyDone;
  }

  stopReason(): TaskStop | undefined {
    if (this.earlyWithoutProgress > this.maxEarlyDone) return "early-done-limit";
    if (this.onFailure === "stop" || !this.hasPendingWork) {
      const tasks = [...this.tasks.values()];
      if (tasks.some(task => task.verification === "failed")) return "task-failed";
      if (tasks.some(task => task.route === "unavailable")) return "task-unavailable";
    }
    return undefined;
  }

  report(reason: DiscoveryTaskStopReason): DiscoveryTaskReport {
    const tasks = [...this.tasks.values()].map(({ id, route, verification }) => ({ id, route, verification }));
    return { reason, modelDoneCount: this.doneCount, tasks,
      completed: tasks.filter(task => task.route === "completed").map(task => task.id),
      remaining: tasks.filter(task => task.route !== "completed").map(task => task.id) };
  }
}
