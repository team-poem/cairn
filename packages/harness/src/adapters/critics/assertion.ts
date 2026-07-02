/** Deterministic Critic for the replay path — checks assertions against evidence, no LLM (invariant #4). */
import type { AssertionHandler, Critic } from "../../core/ports.js";
import type { Assertion, AssertionResult, Context, Evidence, Verdict } from "../../core/types.js";
import { isBenignRequest, isRecoveredFailure } from "../../core/requests.js";
import { urlReached } from "../../core/steps.js";

/** A product-defined check for a `{ kind: "custom", name }` assertion — the host decides what success means. */
export type CustomCheck = (
  params: Record<string, unknown>,
  evidence: Evidence,
) => boolean | { passed: boolean; detail?: string } | Promise<boolean | { passed: boolean; detail?: string }>;

export type CustomChecks = Record<string, CustomCheck>;

/** Evaluate one mechanical assertion. `expect` is not mechanical — returns unsupported (LlmCritic handles it). */
export function checkAssertion(
  assertion: Assertion,
  evidence: Evidence,
  benign: readonly string[] = [],
  benignConsole: readonly string[] = [],
): AssertionResult {
  switch (assertion.kind) {
    case "navigated": {
      const { navigated, finalUrl } = evidence.execution;
      if (!navigated) return { assertion, passed: false, detail: "no navigation occurred" };
      if (assertion.to && !urlReached(finalUrl ?? "", assertion.to)) {
        return { assertion, passed: false, detail: `final url ${finalUrl} did not reach ${assertion.to}` };
      }
      return { assertion, passed: true, detail: finalUrl };
    }
    case "no-console-errors": {
      // Product-marked patterns (framework/i18n noise) are not regressions — mirror of benign requests.
      const errors = evidence.logic.console.filter(
        (m) => m.type === "error" && !benignConsole.some((s) => m.text.includes(s)),
      );
      return errors.length === 0
        ? { assertion, passed: true }
        : { assertion, passed: false, detail: `${errors.length} console error(s): ${errors[0]?.text}` };
    }
    case "no-failed-requests": {
      // Ignore universally-benign noise (a missing favicon shouldn't fail a checkout test) and
      // transient failures the app retried and recovered (#66) — an unrecovered failure still fails.
      const requests = evidence.logic.requests;
      const failed = requests.filter(
        (r, i) => r.status >= 400 && !isBenignRequest(r.url, benign) && !isRecoveredFailure(requests, i),
      );
      return failed.length === 0
        ? { assertion, passed: true }
        : { assertion, passed: false, detail: `${failed.length} failed request(s): ${failed[0]?.status} ${failed[0]?.url}` };
    }
    case "request-status": {
      const match = evidence.logic.requests.find((r) => r.url.includes(assertion.urlIncludes));
      if (!match) return { assertion, passed: false, detail: `no request matching ${assertion.urlIncludes}` };
      return match.status === assertion.status
        ? { assertion, passed: true, detail: `${match.status} ${match.url}` }
        : { assertion, passed: false, detail: `expected ${assertion.status}, got ${match.status} for ${match.url}` };
    }
    case "expect":
      return { assertion, passed: false, detail: "'expect' is judged by LlmCritic, not the deterministic critic" };
    case "custom":
      return { assertion, passed: false, detail: `custom check "${assertion.name}" needs a registered handler` };
  }
}

/** Built-in mechanical checks — every kind except product `custom` (`expect` yields its LlmCritic hint). */
export class MechanicalAssertionHandler implements AssertionHandler {
  constructor(
    private readonly benign: readonly string[] = [],
    private readonly benignConsole: readonly string[] = [],
  ) {}

  supports(assertion: Assertion): boolean {
    return assertion.kind !== "custom";
  }

  judge(assertion: Assertion, evidence: Evidence): AssertionResult {
    return checkAssertion(assertion, evidence, this.benign, this.benignConsole);
  }
}

/** Product-defined `{ kind: "custom", name }` checks via a name→check registry. */
export class CustomAssertionHandler implements AssertionHandler {
  constructor(private readonly custom: CustomChecks = {}) {}

  supports(assertion: Assertion): boolean {
    return assertion.kind === "custom";
  }

  async judge(assertion: Assertion, evidence: Evidence): Promise<AssertionResult> {
    if (assertion.kind !== "custom") throw new Error(`custom handler received "${assertion.kind}" assertion`);
    const check = this.custom[assertion.name];
    if (!check) return { assertion, passed: false, detail: `no custom check registered for "${assertion.name}"` };
    const r = await check(assertion.params ?? {}, evidence);
    return typeof r === "boolean" ? { assertion, passed: r } : { assertion, passed: r.passed, detail: r.detail };
  }
}

/** Route one assertion to the first handler that supports it (mirror of the Execute-stage step dispatch). */
export async function judgeAssertion(
  handlers: AssertionHandler[],
  assertion: Assertion,
  evidence: Evidence,
  ctx?: Context,
): Promise<AssertionResult> {
  const handler = handlers.find((h) => h.supports(assertion));
  if (!handler) return { assertion, passed: false, detail: `no critic handles "${assertion.kind}"` };
  return handler.judge(assertion, evidence, ctx);
}

/** Resolve any assertion — a registered `custom` handler, else the built-in mechanical check. */
export function resolveAssertion(
  assertion: Assertion,
  evidence: Evidence,
  custom: CustomChecks = {},
): Promise<AssertionResult> {
  return judgeAssertion([new MechanicalAssertionHandler(), new CustomAssertionHandler(custom)], assertion, evidence);
}

export class AssertionCritic implements Critic {
  private readonly handlers: AssertionHandler[];

  /**
   * @param custom product-defined checks for `custom` assertions, keyed by name.
   * @param benign URL substrings whose 4xx/5xx is product noise, not a regression (P7).
   * @param benignConsole console-text substrings that are product noise (framework/i18n), not errors (#66).
   */
  constructor(
    custom: CustomChecks = {},
    benign: readonly string[] = [],
    benignConsole: readonly string[] = [],
  ) {
    this.handlers = [new MechanicalAssertionHandler(benign, benignConsole), new CustomAssertionHandler(custom)];
  }

  async judge(evidence: Evidence, assertions: Assertion[]): Promise<Verdict> {
    const results = await Promise.all(assertions.map((a) => judgeAssertion(this.handlers, a, evidence)));
    return { passed: results.every((r) => r.passed), results };
  }
}
