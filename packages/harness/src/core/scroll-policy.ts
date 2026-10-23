import type { ActionPolicy, PolicyContext, PolicyDiagnostic } from "./discover/decision.js";
import { scrollStateKey } from "./action-policy.js";

export interface ScrollNoProgressOptions {
  /** Repeated executed transitions within known states before rejecting more scrolls. Default 4. */
  tolerance?: number;
  /** Further observation/decision turns allowed to recover. Default 3. */
  recoveryTurns?: number;
  /** Maximum distinct state signatures retained per run. Default 32, max 256. */
  historySize?: number;
  /** Maximum serialized characters per state; larger observations abstain. Default 32768. */
  maxStateChars?: number;
}

const reason = "Repeated executed scrolls revisited known page states without observed progress. " +
  "Try an untried direction, a different target or navigation, or verify the goal; this scroll direction is blocked.";

/** Optional, deterministic authoring safeguard. No model calls, hashes in reports, or replay changes.
 * Full semantic multisets preserve duplicate counts and control state, not refs or row ordering.
 * A new position is progress even if offscreen controls were already in the accessibility tree. */
export function createScrollNoProgressPolicy(options: ScrollNoProgressOptions = {}): ActionPolicy {
  const integer = (value: number | undefined, fallback: number, min: number, max: number, name: string) => {
    const n = value ?? fallback;
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return n;
  };
  const tolerance = integer(options.tolerance, 4, 1, 256, "tolerance");
  const recoveryLimit = integer(options.recoveryTurns, 3, 1, 32, "recoveryTurns");
  const historySize = integer(options.historySize, 32, 2, 256, "historySize");
  const maxChars = integer(options.maxStateChars, 32768, 256, 262144, "maxStateChars");
  const createRun = (): ActionPolicy => {
    const history = new Map<string, Set<"up" | "down">>();
    const recoveryProbes = new Set<"up" | "down">();
    let current: string | undefined;
    let pending: { from: string; direction: "up" | "down" } | undefined;
    let repeated = 0, recovery = 0;
    let lastDirection: "up" | "down" | undefined;
    const diagnostic = (): PolicyDiagnostic => ({ code: "no-progress", repeatedTransitions: repeated, recoveryTurns: recovery, lastDirection });
    const signature = (ctx: PolicyContext): string | undefined => {
      const position = scrollStateKey(ctx.scroll);
      if (!position || !ctx.url || ctx.url.length > maxChars || ctx.elements.length > maxChars / 8) return;
      let size = position.length + ctx.url.length;
      const rows: string[] = [];
      for (const e of ctx.elements) {
        // Preserve absent vs measured false; ignore rotating refs and region handles.
        const row = JSON.stringify([e.role, e.name, e.value, e.checked, e.disabled, e.inActivePopup, e.occluded, e.clickable]);
        size += row.length;
        if (size > maxChars) return;
        rows.push(row);
      }
      const key = JSON.stringify([ctx.url, position, rows.sort()]);
      return key.length <= maxChars ? key : undefined;
    };
    return {
      needsScrollState: true,
      observe(ctx) {
        const next = signature(ctx);
        if (!next) {
          // A gap breaks attribution. It is neither progress nor evidence of a cycle.
          current = undefined; pending = undefined; history.clear(); recoveryProbes.clear(); repeated = 0; recovery = 0; lastDirection = undefined;
          return;
        }
        const known = history.has(next);
        if (!known) { repeated = 0; recovery = 0; recoveryProbes.clear(); }
        else {
          // Even a permitted recovery scroll consumes a turn if it only revisits known state.
          if (repeated >= tolerance) recovery++;
          if (pending && history.has(pending.from)) repeated++;
        }
        if (pending) lastDirection = pending.direction;
        pending = undefined;
        current = next;
        const directions = history.get(next) ?? new Set<"up" | "down">();
        history.delete(next); history.set(next, directions);
        if (history.size > historySize) history.delete(history.keys().next().value!);
      },
      executed(step) {
        pending = step.kind === "scroll" && current ? { from: current, direction: step.direction ?? "down" } : undefined;
        if (pending) {
          history.get(pending.from)?.add(pending.direction);
          if (repeated >= tolerance) recoveryProbes.add(pending.direction);
        }
      },
      vet(decision) {
        const direction = decision.direction ?? "down";
        const untried = current && !history.get(current)?.has(direction) && !recoveryProbes.has(direction);
        return decision.action === "scroll" && repeated >= tolerance && !untried
          ? { ok: false, reason, diagnostic: diagnostic() } : { ok: true };
      },
      incomplete: () => repeated >= tolerance ? { diagnostic: diagnostic(), halt: recovery >= recoveryLimit } : undefined,
    };
  };
  // The configuration itself never retains a run's history. Loops instantiate through createRun.
  return { needsScrollState: true, vet: () => ({ ok: true }), createRun };
}
