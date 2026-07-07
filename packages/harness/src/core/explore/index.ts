/**
 * The explore loop — the discover loop's freeze-less sibling (#102). Same observe→decide→act
 * machinery (invariant #3: the loop exists exactly for exploring an unfamiliar app), but instead
 * of freezing a Scenario it wanders the app under a charter and collects FINDINGS — UX problems
 * derived mechanically from each action's observation delta, plus problems the model itself
 * records with `note`. Emits an ExploreReport; nothing here touches the replay path, so
 * invariant #4 (deterministic replay) is untouched.
 *
 * Module layout mirrors discover: prompt (LLM surface) · findings (pure delta analysis) ·
 * this file owns only the loop. Decision parsing/execution and the ActionPolicy seam are
 * SHARED with discover — one execution path, one safety gate (invariant #2).
 */
import type { Driver, LlmClient } from "../ports.js";
import type { RunUsage, Step } from "../types.js";
import { UsageMeter } from "../usage.js";
import { applyDecision, describeAction, parseDecision } from "../discover/decision.js";
import type { ActionPolicy, Decision } from "../discover/decision.js";
import { renderRankedElements } from "../discover/prompt.js";
import { destinationKey } from "../discover/capture.js";
import { EXPLORE_SYSTEM, buildExplorePrompt } from "./prompt.js";
import { dedupeFindings, deriveActionFindings } from "./findings.js";
import type { ActionMark, ActionOutcome, Finding } from "./findings.js";

export interface ExploreOptions {
  driver: Driver;
  llm: LlmClient;
  /** Where the survey starts. */
  baseUrl: string;
  /** Step cap for the loop — exploration wanders, so the default is looser than discover's. */
  maxSteps?: number;
  /** Fired per decision (with the executed Step, when one ran) — a host's live timeline. */
  onStep?: (decision: Decision, step?: Step) => void;
  /** Fired as each finding is recorded — a host's live findings feed. */
  onFinding?: (finding: Finding) => void;
  /** Abort exploration between steps (a host's Stop button). */
  signal?: AbortSignal;
  /** Gate proposed actions (block destructive controls, fence the origin, declare coverage done
   * via `stop`). The SAME seam discover takes — one safety surface for both loops. */
  policy?: ActionPolicy;
  /** URL substrings whose 4xx/5xx is product noise — excluded from failed-request findings. */
  benign?: string[];
  /** Console-text substrings that are product noise — excluded from console-error findings. */
  benignConsole?: string[];
  /** Settle wall-time at/above this becomes a slow-settle finding. Default 5000ms. */
  slowSettleMs?: number;
}

export interface ExploreReport {
  charter: string;
  /** Distinct destinations (host+path) the survey reached, in first-visit order. */
  visited: string[];
  /** Every executed step, including the seed goto — the reproduction trail findings point into. */
  steps: Step[];
  /** Deduped findings, first-seen order. Severity ordering is the renderer's job. */
  findings: Finding[];
  usage: RunUsage;
  /** True when the loop hit the step cap (or gave up on consecutive policy blocks) before the
   * model — or the policy's `stop` — called the charter covered. */
  truncated: boolean;
  finalUrl?: string;
}

/** Same rationale as discover (#77): past this many consecutive policy rejections, the LLM has
 * nothing the policy will allow — stop burning calls. */
const MAX_CONSECUTIVE_BLOCKS = 3;

const DEFAULT_MAX_STEPS = 40;

export async function explore(charter: string, opts: ExploreOptions): Promise<ExploreReport> {
  const {
    driver,
    baseUrl,
    maxSteps = DEFAULT_MAX_STEPS,
    onStep,
    onFinding,
    signal,
    policy,
    benign = [],
    benignConsole = [],
    slowSettleMs,
  } = opts;
  // Meter at the seam so the report always carries what the survey cost (#100).
  const llm = new UsageMeter(opts.llm);

  const steps: Step[] = [];
  const findings: Finding[] = [];
  const visited: string[] = [];
  const record = (finding: Finding): void => {
    findings.push(finding);
    onFinding?.(finding);
  };
  const visit = (url: string | undefined): void => {
    if (!url) return;
    const key = destinationKey(url);
    if (!visited.includes(key)) visited.push(key);
  };

  // Deduped failure memory, exactly as in discover — ADAPT is the point of the loop.
  const failures: string[] = [];
  const pushFailure = (line: string): void => {
    if (!failures.includes(line)) failures.push(line);
  };

  await driver.goto(baseUrl);
  steps.push({ kind: "goto", url: baseUrl });
  let currentUrl: string | undefined = baseUrl;
  visit(baseUrl);

  // The previous action awaiting its outcome verdict. Findings are derived RETROACTIVELY at the
  // next iteration's observation (the same stance as discover's marks, #81), so the one
  // settle+observe+snapshot per turn serves both as the previous action's outcome and the next
  // decision's input — no second observation per action.
  let pending: { mark: ActionMark; decision: Decision; stepIndex: number } | null = null;
  const settleOutcome = (
    mark: ActionMark,
    decision: Decision,
    stepIndex: number,
    outcome: ActionOutcome,
  ): void => {
    for (const f of deriveActionFindings(mark, outcome, decision, stepIndex, {
      benign,
      benignConsole,
      slowSettleMs,
    })) {
      record(f);
    }
  };

  let prevRender = "";
  let truncated = true;
  let consecutiveBlocks = 0;

  for (let i = 0; i < maxSteps; i++) {
    signal?.throwIfAborted();
    const settleStart = Date.now();
    await driver.settle();
    const settleMs = Date.now() - settleStart;
    const observation = await driver.observe();
    currentUrl = observation.execution.finalUrl ?? currentUrl;
    visit(observation.execution.finalUrl);
    const elements = await driver.snapshot();
    const render = renderRankedElements(elements, charter);

    if (pending) {
      settleOutcome(pending.mark, pending.decision, pending.stepIndex, {
        url: observation.execution.finalUrl,
        requests: observation.logic.requests,
        console: observation.logic.console,
        render,
        settleMs,
      });
      pending = null;
    }

    // Coverage check on the fresh page — a policy `stop` here is a trusted "charter covered".
    if (policy?.stop?.(steps, { elements, url: currentUrl })) {
      truncated = false;
      break;
    }

    const reply = await llm.complete(
      buildExplorePrompt(charter, render, prevRender, steps, failures, visited, findings, currentUrl),
      { system: EXPLORE_SYSTEM },
    );
    prevRender = render;

    let decision: Decision;
    try {
      decision = parseDecision(reply);
    } catch {
      pushFailure("your previous reply was not a single valid JSON action object");
      continue;
    }

    if (decision.action === "done") {
      truncated = false;
      onStep?.(decision);
      break;
    }

    if (decision.action === "note") {
      const text = decision.text?.trim() || decision.reason?.trim();
      if (!text) {
        pushFailure('your "note" action had no "text" — a note must state the problem');
        continue;
      }
      record({
        kind: "agent-note",
        severity: decision.severity ?? "info",
        detail: text,
        key: `agent-note:${text.slice(0, 120)}`,
        url: currentUrl,
        stepIndex: steps.length - 1,
      });
      onStep?.(decision);
      continue;
    }

    try {
      // Policy gate — same placement and semantics as discover: a rejected action never executes,
      // a throwing vet is a recorded rejection, not a lost survey.
      const verdict = policy?.vet(decision, { elements, url: currentUrl }) ?? { ok: true as const };
      if (!verdict.ok) {
        pushFailure(`${describeAction(decision)} — blocked by policy: ${verdict.reason}`);
        onStep?.(decision);
        if (++consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) break; // report what exists, truncated
        continue;
      }
      consecutiveBlocks = 0;
      const mark: ActionMark = {
        url: observation.execution.finalUrl,
        requestCount: observation.logic.requests.length,
        consoleCount: observation.logic.console.length,
        render,
      };
      const step = await applyDecision(driver, decision);
      if (decision.reason?.trim()) step.intent = decision.reason.trim();
      steps.push(step);
      pending = { mark, decision, stepIndex: steps.length - 1 };
      onStep?.(decision, step);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushFailure(`${describeAction(decision)} — ${message}`);
      // An action the page wouldn't take is itself a UX signal — an overlay-covered button, a
      // control that exists in the tree but can't be driven.
      record({
        kind: "action-error",
        severity: "warn",
        detail: `${describeAction(decision)} failed: ${message}`,
        key: `action-error:${decision.action}:${decision.text ?? decision.url ?? ""}`,
        url: currentUrl,
        stepIndex: steps.length - 1,
      });
      onStep?.(decision);
    }
  }

  // The loop only judges an action at the NEXT iteration — give the last executed action its
  // outcome observation too, or its failures would silently vanish.
  if (pending) {
    const settleStart = Date.now();
    await driver.settle();
    const settleMs = Date.now() - settleStart;
    const observation = await driver.observe();
    currentUrl = observation.execution.finalUrl ?? currentUrl;
    visit(observation.execution.finalUrl);
    settleOutcome(pending.mark, pending.decision, pending.stepIndex, {
      url: observation.execution.finalUrl,
      requests: observation.logic.requests,
      console: observation.logic.console,
      render: renderRankedElements(await driver.snapshot(), charter),
      settleMs,
    });
  }

  return {
    charter,
    visited,
    steps,
    findings: dedupeFindings(findings),
    usage: llm.snapshot(),
    truncated,
    finalUrl: currentUrl,
  };
}
