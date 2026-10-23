import type { Driver } from "./ports.js";
import type { ScrollState } from "./types.js";
import type { ActionPolicy, PolicyContext } from "./discover/decision.js";

/** Compose gates without turning another gate's veto into an executed action. A trusted
 * stop from any component still means goal reached; incomplete never overrides that evidence. */
export function composePolicies(...policies: readonly ActionPolicy[]): ActionPolicy {
  const compose = (items: readonly ActionPolicy[]): ActionPolicy => ({
    needsScrollState: items.some(p => p.needsScrollState),
    vet(decision, ctx) {
      for (const policy of items) {
        const verdict = policy.vet(decision, ctx);
        if (!verdict.ok) return verdict;
      }
      return { ok: true };
    },
    observe: ctx => { for (const policy of items) policy.observe?.(ctx); },
    executed: (step, ctx) => { for (const policy of items) policy.executed?.(step, ctx); },
    stop: (steps, ctx) => items.some(p => p.stop?.(steps, ctx)),
    incomplete() {
      const states = items.map(p => p.incomplete?.()).filter(s => s !== undefined);
      return states.find(s => s.halt) ?? states[0];
    },
  });
  return { ...compose(policies), createRun: () => compose(policies.map(p => p.createRun?.() ?? p)) };
}

/** Compare explicit fields, not insertion order or a driver's optional extra properties. */
export function scrollStateKey(state: ScrollState | undefined): string | undefined {
  if (!state || typeof state.region !== "string" || !state.region || state.region.length > 512) return;
  const values = [state.x, state.y, state.width, state.height, state.scrollWidth, state.scrollHeight];
  if (!values.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0) ||
      state.width <= 0 || state.height <= 0 || state.scrollWidth < state.width || state.scrollHeight < state.height ||
      state.x > state.scrollWidth - state.width + 1 || state.y > state.scrollHeight - state.height + 1) return;
  return JSON.stringify([state.region, ...values]);
}

/** Bracket the caller's existing snapshot. Never reuse position evidence across a capture
 * that moved/navigated/resized. Unsupported drivers simply omit the optional capability. */
export async function readPolicyScroll(policy: ActionPolicy | undefined, driver: Driver): Promise<ScrollState | undefined> {
  if (!policy?.needsScrollState || !driver.scrollState) return;
  const state = await driver.scrollState();
  return scrollStateKey(state) === undefined ? undefined : { ...state! };
}

export function policyContext(elements: PolicyContext["elements"], url: string | undefined,
  before: ScrollState | undefined, after: ScrollState | undefined): PolicyContext {
  return { elements, url, ...(before && after && scrollStateKey(before) === scrollStateKey(after) ? { scroll: after } : {}) };
}
