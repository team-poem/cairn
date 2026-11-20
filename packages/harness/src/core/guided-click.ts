/** Freshness for one host-guided, reference-free click. Nothing here is persisted for replay. */
import type { Decision } from "./discover/decision.js";
import { errorKindOf } from "./errors.js";
import { captureGuidanceScope, compareGuidanceScope, ScopedGuidanceExpired,
  type CapturedGuidanceScope, type PageGuidanceScope, type GuidanceScopeDiagnostic } from "./guidance-scope.js";
import type { PerceptionObservation } from "./observation.js";
import { pageGuidanceUrlInvalidation, type PageGuidance } from "./page-guidance.js";
import type { Driver } from "./ports.js";
import type { PageElement, Target } from "./types.js";

const unavailable: GuidanceScopeDiagnostic = { scopeStatus: "scope-unverifiable" };
const ambiguous: GuidanceScopeDiagnostic = { scopeStatus: "target-ambiguous", targetUnambiguous: false };

function checkListing(elements: readonly PageElement[], scope: PageGuidanceScope): GuidanceScopeDiagnostic | undefined {
  const matches = elements.filter(e => e.role === scope.target.role && e.name === scope.target.name);
  if (matches.length > 1) return ambiguous;
  if (matches.length === 0 || matches[0]!.disabled || matches[0]!.occluded) return unavailable;
}

/** Bind the baseline to what the model actually saw, before either host or model work can
 * mutate a Driver-owned array. Truncated or perceived rows never prove complete membership. */
export function listedScopeBaseline(scope: PageGuidanceScope | undefined, facts: CapturedGuidanceScope | undefined,
  page: PerceptionObservation): CapturedGuidanceScope | undefined {
  if (!scope || !facts || "error" in facts) return facts;
  const failure = checkListing(page.listed.map(({ element }) => element), scope);
  if (failure) return { error: failure };
  if (page.listed.some(({ element, nth }) => nth !== undefined && element.role === scope.target.role && element.name === scope.target.name))
    return { error: ambiguous };
  return facts;
}

export async function readGuidedPage(driver: Driver, scope?: PageGuidanceScope) {
  if (scope && driver.snapshotWithGuidanceScope) {
    const { elements, facts } = await driver.snapshotWithGuidanceScope(scope);
    const baseline = captureGuidanceScope(scope, facts);
    const error = checkListing(elements, scope);
    return { elements, baseline: error && !("error" in baseline) ? { error } : baseline };
  }
  return { elements: await driver.snapshot({ perception: true }), baseline: undefined };
}

class GuidanceUrlChanged extends Error {}

/** Both loops report this stop without exposing the driver's error or attesting to a click. */
const uncertainClick = {
  code: "click-dispatch-uncertain",
  reason: "the driver did not confirm the guided click; it was not retried",
} as const;

type GuidedFailure = typeof uncertainClick | { reason: string; diagnostic?: GuidanceScopeDiagnostic };

function guidanceRejection(error: unknown): GuidedFailure | undefined {
  if (error instanceof ScopedGuidanceExpired) {
    // Third-party adapters may annotate an exception. Never forward their message or extra fields.
    const fixed = new ScopedGuidanceExpired(error.diagnostic);
    return { reason: fixed.message, diagnostic: fixed.diagnostic };
  }
  if (error instanceof GuidanceUrlChanged) return { reason: error.message };
  return undefined;
}

export type ValidateGuidedClick = () => Promise<{ target: Target; ref: string; check: () => void; checkBeforeDispatch: () => void }>;

export function scopedClick(driver: Driver, scope: PageGuidanceScope | undefined, baseline: CapturedGuidanceScope | undefined,
  guidance: PageGuidance | undefined, decision: Decision,
  check: () => void, signal: AbortSignal | undefined, onUrl: (url: string | undefined) => void) {
  if (!guidance?.declaredScope || !scope) return;
  const matchesDecision = () => decision.action === "click" && decision.ref === undefined &&
    decision.nth === undefined && decision.text === scope.target.name && decision.role === scope.target.role;
  if (!matchesDecision()) return;

  const baselineError = !baseline ? unavailable : "error" in baseline ? baseline.error :
    baseline.blocked ? { ...unavailable, targetUnambiguous: true } : undefined;

  let dispatchPossible = false;
  const checkClick = () => {
    check();
    // A policy may have changed the decision since it qualified for this scope.
    if (!matchesDecision()) throw new ScopedGuidanceExpired(unavailable);
  };
  const checkBeforeDispatch = () => {
    checkClick();
    dispatchPossible = true;
  };
  const failure = (error: unknown): GuidedFailure | undefined => {
    if (!dispatchPossible) return guidanceRejection(error);
    // Only the adapter calls checkBeforeDispatch, immediately before submitting input.
    // An exception after that boundary cannot justify repeating the click, even if the
    // adapter labels the error as a stale reference. Transport and run stops still throw.
    if (errorKindOf(error) === "transport" ||
        (error instanceof Error && (error.name === "AbortError" || error.name === "BudgetExceededError"))) return;
    return uncertainClick;
  };
  const validate: ValidateGuidedClick = async () => {
    checkClick();
    if (!baseline || !driver.snapshotWithGuidanceScope) throw new ScopedGuidanceExpired(unavailable);
    // This read resolves the target. Ordinary locate() could choose a fuzzy match or a
    // structural index that no longer identifies the node when the receipt is used.
    let capture;
    try {
      capture = await driver.snapshotWithGuidanceScope(scope);
    } catch (error) {
      if (errorKindOf(error) === "resolution") throw new ScopedGuidanceExpired(unavailable);
      throw error;
    }
    checkClick();
    const { elements, facts, targetRef } = capture;
    const after = captureGuidanceScope(scope, facts);
    const diagnostic = compareGuidanceScope(baseline, after) ?? checkListing(elements, scope);
    const urlChanged = await pageGuidanceUrlInvalidation(driver, guidance, signal, onUrl);
    checkClick();
    if (urlChanged) throw new GuidanceUrlChanged(urlChanged);
    if (diagnostic) throw new ScopedGuidanceExpired(diagnostic);
    if (typeof targetRef !== "string" || !targetRef.trim())
      throw new ScopedGuidanceExpired({ ...unavailable, targetUnambiguous: true });
    return { target: { role: scope.target.role, text: scope.target.name }, ref: targetRef, check: checkClick, checkBeforeDispatch };
  };
  return { baselineError, validate, failure };
}
