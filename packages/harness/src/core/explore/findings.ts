/**
 * Findings the explore loop derives from each action's observation delta — the freeze-less half
 * of the loop's value (#102). Everything here is a pure function over Evidence slices: mechanical,
 * deterministic, table-testable (the same stance as the critics). The LLM contributes only
 * `agent-note` findings; it never judges these.
 */
import type { ConsoleMessage, NetworkRequest } from "../types.js";
import type { Decision } from "../discover/decision.js";
import { describeAction } from "../discover/decision.js";
import { destinationKey } from "../discover/capture.js";
import { isBenignRequest, isRecoveredFailure } from "../requests.js";

export type FindingKind =
  /** a request the action fired failed for real (benign and recovered noise excluded) */
  | "failed-request"
  /** a console error surfaced after the action */
  | "console-error"
  /** an effectful action ran ok but nothing observable changed — to a user, a button that does nothing */
  | "dead-action"
  /** the action itself failed to execute (target didn't resolve, driver error) */
  | "action-error"
  /** the page took longer than the threshold to quiesce after the action */
  | "slow-settle"
  /** a UX problem the exploring model observed and recorded with a `note` decision */
  | "agent-note";

export type FindingSeverity = "info" | "warn" | "error";

export interface Finding {
  kind: FindingKind;
  severity: FindingSeverity;
  /** What a reader needs to locate and reproduce the problem. */
  detail: string;
  /** Identity for deduping repeats of the same problem across steps (an error a page throws on
   * every action) — stable across occurrences where `detail` may not be. */
  key: string;
  /** Page URL where the finding was observed, when known. */
  url?: string;
  /** Index into the report's `steps` of the action this finding is attributed to; for findings not
   * tied to an executed step (`agent-note`, `action-error`) the last executed step at the time. */
  stepIndex: number;
  /** How many times the deduped problem occurred (absent = once); set by `dedupeFindings`. */
  occurrences?: number;
}

/** What the loop records just before executing an action: the page URL, the lengths of the
 * append-only request/console logs (so the slice past them is exactly what the action caused),
 * and the element render (for the dead-action comparison). */
export interface ActionMark {
  url?: string;
  requestCount: number;
  consoleCount: number;
  render: string;
}

/** The completed observation after the action settled — cumulative logs plus the fresh render. */
export interface ActionOutcome {
  url?: string;
  requests: readonly NetworkRequest[];
  console: readonly ConsoleMessage[];
  render: string;
  /** Post-action settle wall-time; absent when the caller didn't time it. */
  settleMs?: number;
}

export interface FindingOptions {
  /** URL substrings whose 4xx/5xx is product noise — mirror of `RunScenarioOptions.benign`. */
  benign?: readonly string[];
  /** Console-text substrings that are product noise — mirror of `RunScenarioOptions.benignConsole`. */
  benignConsole?: readonly string[];
  /** Settle wall-time at/above this is a slow-settle finding. */
  slowSettleMs?: number;
}

const DEFAULT_SLOW_SETTLE_MS = 5_000;

/** Actions that promise an observable state change when they work — the kinds a
 * "nothing happened" delta indicts. A type/hover/scroll changing nothing is normal. */
const EXPECTS_EFFECT = new Set<Decision["action"]>(["click", "select"]);

/** host + path of a request URL — the stable identity repeats of the same failure share. */
function endpointLabel(url: string): string {
  return destinationKey(url);
}

/**
 * Derive the mechanical findings one executed action produced, from the delta between the mark
 * taken before it and the settled observation after it. Pure — the caller owns when to observe.
 */
export function deriveActionFindings(
  mark: ActionMark,
  outcome: ActionOutcome,
  decision: Decision,
  stepIndex: number,
  opts: FindingOptions = {},
): Finding[] {
  const { benign = [], benignConsole = [], slowSettleMs = DEFAULT_SLOW_SETTLE_MS } = opts;
  const findings: Finding[] = [];
  const url = outcome.url ?? mark.url;
  const action = describeAction(decision);

  // Logic layer — requests in the action's own tail that failed for real. Benign and recovered
  // noise are excluded with the same predicates as `no-failed-requests`, so an explore finding
  // is never stricter than a replay verdict would be.
  for (let i = mark.requestCount; i < outcome.requests.length; i++) {
    const r = outcome.requests[i]!;
    if (r.status >= 400 && !isBenignRequest(r.url, benign) && !isRecoveredFailure(outcome.requests, i)) {
      findings.push({
        kind: "failed-request",
        severity: "error",
        detail: `${r.method.toUpperCase()} ${r.url} → ${r.status} (after ${action})`,
        key: `failed-request:${r.method.toUpperCase()} ${endpointLabel(r.url)}`,
        url,
        stepIndex,
      });
    }
  }

  for (const m of outcome.console.slice(mark.consoleCount)) {
    if (m.type === "error" && !benignConsole.some((s) => m.text.includes(s))) {
      findings.push({
        kind: "console-error",
        severity: "error",
        detail: `console error after ${action}: ${m.text.slice(0, 200)}`,
        key: `console-error:${m.text.slice(0, 120)}`,
        url,
        stepIndex,
      });
    }
  }

  // Dead action: judged at destination granularity (a query/hash-only move still counts as an
  // effect via the render change it causes, not the URL). All three layers must be silent —
  // no navigation, no request, no element change — before an action is called dead.
  if (EXPECTS_EFFECT.has(decision.action)) {
    const sameUrl =
      !!mark.url && !!outcome.url && destinationKey(mark.url) === destinationKey(outcome.url);
    const firedRequests = outcome.requests.length > mark.requestCount;
    if (sameUrl && !firedRequests && outcome.render === mark.render) {
      findings.push({
        kind: "dead-action",
        severity: "warn",
        detail: `${action} had no observable effect — no navigation, no request, no page change`,
        key: `dead-action:${decision.text ?? decision.action}`,
        url,
        stepIndex,
      });
    }
  }

  if (outcome.settleMs !== undefined && outcome.settleMs >= slowSettleMs) {
    findings.push({
      kind: "slow-settle",
      severity: "warn",
      detail: `page took ${(outcome.settleMs / 1000).toFixed(1)}s to settle after ${action}`,
      key: `slow-settle:${url ? destinationKey(url) : action}`,
      url,
      stepIndex,
    });
  }

  return findings;
}

/** Collapse repeats of the same problem (same `key`) into the first occurrence with an
 * `occurrences` count, keeping first-seen order — a page that throws the same console error on
 * every action is one finding, not thirty. */
export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const f of findings) {
    const seen = byKey.get(f.key);
    if (seen) {
      seen.occurrences = (seen.occurrences ?? 1) + 1;
    } else {
      byKey.set(f.key, { ...f });
    }
  }
  return [...byKey.values()];
}
