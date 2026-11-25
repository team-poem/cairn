import { ActionOutcomeTracker, type ActionOutcomeOptions, type ActionOutcomeStatus } from "../action-outcomes.js";
import { sameCapturePath } from "../evidence-capture.js";
import { BudgetExceededError } from "../budget.js";
import type { Driver, PerceptionAdapter } from "../ports.js";
import { redactSecrets, type Secrets } from "../secrets.js";
import type { Evidence, PageElement, Scenario, Step } from "../types.js";
import type { Decision } from "./decision.js";
import { snapshotCleanupSteps, type DiscoveryRefusal, type ReplayCleanupRecording } from "../replay-cleanup.js";

type Frame = ReturnType<ActionOutcomeTracker["capture"]>;
type Receipt = { index: number; id?: string; frame?: Frame; settled?: Frame; outcome?: ActionOutcomeStatus };

// All measured PageElement fields are scalars except actions. Drivers may also attach
// private data (even functions); a cleanup recording does not serialize those fields.
export function copyCleanupRows(rows: readonly PageElement[]): PageElement[] {
  return rows.map(row => ({ ...row, ...(row.actions && { actions: { ...row.actions } }) }));
}

/** Neither an unavailable optional probe nor a rejected host correction should cancel input. */
function rethrowStop(error: unknown, check: () => void): void {
  check();
  if (error instanceof BudgetExceededError || (error instanceof Error && error.name === "AbortError")) throw error;
}

async function readFrame(driver: Driver, read: () => Promise<PageElement[]>, outcomes: ActionOutcomeTracker,
  expected: Frame, perceive: PerceptionAdapter | undefined, secrets: Secrets | undefined,
  check: () => void): Promise<{ frame: Frame; evidence: Evidence }> {
  check();
  const result = await read();
  check();
  const raw = perceive ? copyCleanupRows(result) : result;
  const rows = redactSecrets(perceive ? await perceive(copyCleanupRows(raw)) : raw, secrets);
  check();
  // A driver may reuse row objects in observe(). Keep the snapshot's own facts. The
  // caller checks the expected watermark against the independently observed one.
  const frame = outcomes.capture(perceive ? redactSecrets(raw, secrets) : rows, expected.url, expected.requests, perceive ? rows : undefined, true);
  const evidence = await driver.observe();
  check();
  return { evidence, frame };
}

/** Private to one opt-in discovery. No driver identity, page row or request is exported. */
export class CleanupDiscovery {
  private readonly executed: Step[] = [];
  private readonly size = { nodes: 0, chars: 0 };
  private previous?: Receipt;
  private last?: Receipt;
  private invalid = false;
  recording?: ReplayCleanupRecording;
  explicitOutcomes = false;

  track(options?: ActionOutcomeOptions): ActionOutcomeOptions {
    this.explicitOutcomes = options !== undefined;
    // A host's partial row selection is useful for repeat limits, but not for removing a step.
    if (options?.scope) this.invalid = true;
    const notify = options?.onOutcome;
    return { ...options, onOutcome: event => {
      if (this.last?.index === event.stepIndex) this.last.outcome = event.status;
      notify?.(event);
    } };
  }

  record(step: Step, id?: string, frame?: Frame): void {
    if (this.invalid) return;
    if (this.executed.length >= 256) { this.invalidate(); return; }
    try { this.executed.push(...snapshotCleanupSteps([step], this.size)); }
    catch { this.invalidate(); return; }
    this.previous = this.last;
    this.last = { index: this.executed.length - 1, id, frame };
  }

  invalidate(): void {
    this.invalid = true;
    this.executed.length = 0;
    this.previous = this.last = undefined;
  }

  private matches(scenario: Scenario): boolean {
    if (this.invalid || this.executed.length !== scenario.steps.length) return false;
    try { return sameCapturePath(this.executed, snapshotCleanupSteps(scenario.steps)); } catch { return false; }
  }

  /** Compare every valid turn, including re-decisions that send no input. A later equal
   * view cannot erase an intervening observation that disagreed or could not be compared. */
  observe(frame: Frame, evidence: Evidence, outcomes: ActionOutcomeTracker): void {
    const receipt = this.last;
    if (!receipt?.frame) return;
    const step = this.executed[receipt.index]!;
    if (!quietBoundary(evidence, receipt.frame) || !outcomes.unchangedClick(receipt.settled ?? frame, frame, step))
      receipt.frame = undefined;
    else receipt.settled ??= frame;
  }

  async beforeClick(decision: Decision, listed: Frame, evidence: Evidence, driver: Driver, outcomes: ActionOutcomeTracker,
    perceive: PerceptionAdapter | undefined, secrets: Secrets | undefined, check: () => void): Promise<Frame | undefined> {
    if (this.invalid || decision.action !== "click" || !decision.text || decision.nth !== undefined
      || !quietBoundary(evidence, listed) || decision.ref !== undefined && !driver.snapshotForTask) return;
    try {
      const options = { perception: true, actionOutcomes: true };
      // Ordinary perception snapshots may rotate the reference used by the pending input.
      const live = await readFrame(driver, () => driver.snapshotForTask ? driver.snapshotForTask(options) : driver.snapshot(options),
        outcomes, listed, perceive, secrets, check);
      const step = { kind: "click", target: { role: decision.role, text: decision.text } } as const;
      if (quietBoundary(live.evidence, listed) && outcomes.unchangedClick(listed, live.frame, step)) return live.frame;
    } catch (error) { rethrowStop(error, check); }
  }

  private candidate(scenario: Scenario, outcomes: ActionOutcomeTracker): Frame | DiscoveryRefusal {
    const { previous, last } = this;
    if (scenario.truncated || scenario.truncationReason || scenario.unprovenAction !== undefined) return "incomplete-discovery";
    if (!this.matches(scenario)) return "incomplete-recording";
    const first = scenario.steps.at(-2), repeat = scenario.steps.at(-1);
    if (first?.kind !== "click" || repeat?.kind !== "click" || first.expect || repeat.expect
      || !sameCapturePath([first], [repeat])) return "unsupported-path";
    if (!previous?.id || previous.id !== last?.id) return "unconfirmed-click-pair";
    if (!previous.frame || !last.frame || !previous.settled || !last.settled || previous.frame.url !== last.frame.url
      || previous.frame.requests !== last.frame.requests || !outcomes.unchangedClick(previous.settled, last.frame, repeat)
      || !outcomes.unchangedClick(last.frame, last.settled, repeat)) return "unsettled-effects";
    if (previous.outcome !== "observed-change" || last.outcome !== "no-observed-change") return "repeat-not-idle";
    return last.frame;
  }

  /** A last read after assertion proposal catches effects that arrived after the repeat's
   * first settled observation. Failure of this optional read cannot erase a completed freeze. */
  async refusal(scenario: Scenario, evidence: Evidence, driver: Driver, outcomes: ActionOutcomeTracker,
    perceive: PerceptionAdapter | undefined, secrets: Secrets | undefined, check: () => void): Promise<DiscoveryRefusal | undefined> {
    const frame = this.candidate(scenario, outcomes);
    if (typeof frame === "string") return frame;
    if (!quietBoundary(evidence, frame)) return "unsettled-effects";
    try {
      const after = await readFrame(driver, () => driver.snapshot({ perception: true, actionOutcomes: true }),
        outcomes, frame, perceive, secrets, check);
      if (!this.matches(scenario)) return "incomplete-recording";
      return quietBoundary(after.evidence, frame) && outcomes.unchangedClick(frame, after.frame, scenario.steps.at(-1)!) ? undefined : "unsettled-effects";
    } catch (error) {
      rethrowStop(error, check);
      return "incomplete-recording";
    }
  }
}

/** Treat all traffic as relevant, including reads and background requests. A diagnostic
 * can veto an approval; an empty request interval cannot grant one. */
export function quietBoundary(evidence: Evidence, frame: Frame): boolean {
  return !!frame.url && frame.url === evidence.execution.finalUrl && frame.requests === evidence.logic.requests.length
    && !evidence.execution.blocked && evidence.logic.requests.every(r => r.status >= 200 && r.status < 400)
    && !evidence.logic.console.some(message => message.type === "error");
}
