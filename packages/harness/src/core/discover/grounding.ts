/**
 * Freeze-time assertion grounding (#16): the LLM proposes intent-based checks, and everything frozen
 * is verified against the observed evidence — a hallucinated check is dropped, so replay stays
 * deterministic (invariant #4).
 */
import type { LlmClient } from "../ports.js";
import type { Assertion, ConsoleMessage, Evidence, NetworkRequest } from "../types.js";
import { isBenignRequest, isMutation, isRecoveredFailure } from "../requests.js";
import { extractFirstJsonArray } from "../json.js";
import { destinationKey } from "./capture.js";

/**
 * Ground the frozen scenario's assertions in what actually happened, not what the LLM
 * guessed — it would propose `navigated` even on a SPA that never navigates, making every
 * replay fail. Always check requests; add `navigated` only if the run truly navigated;
 * keep a proposed `request-status` ONLY if a captured request actually matches it (so a
 * hallucinated check can't fail every replay). `expect` (LLM-judged) is frozen only when
 * `semantic` is set — otherwise the freeze stays deterministic (invariant #4).
 * `benign` is the product's noise list (mirror of `RunScenarioOptions.benign`) — a marked
 * endpoint's failure never disqualifies a check.
 */
export function deriveAssertions(
  proposed: Assertion[] | undefined,
  evidence: Evidence,
  semantic: boolean,
  benign: readonly string[] = [],
  /** Reports each dropped proposal with why — a drop changed what the freeze checks, so the
   * trace surfaces it as a `gate` event instead of silence (spec/core/trace.md). */
  onDrop?: (proposed: Assertion, reason: string) => void,
): Assertion[] {
  const out: Assertion[] = [];
  // Ground no-failed-requests: freeze it only if it actually HELD during discovery. "Held" uses
  // the SAME tolerance the critic judges with (#66) — benign noise (built-in + product list) and
  // failures the app retried and recovered (401 → 2xx) don't disqualify the check — otherwise the
  // freeze is stricter than the verdict and a legitimate transient retry loses this assertion.
  if (!sawRequestFailure(evidence.logic.requests, benign)) {
    out.push({ kind: "no-failed-requests" });
  }
  // Ground no-console-errors the same way (#99): the prompt offers the kind with `done`, so honor
  // it — but only when the console was actually observed clean throughout discovery. A flow that
  // works despite a pre-existing console error must not freeze a check that was already false.
  if (!sawConsoleErrors(evidence.logic.console)) {
    out.push({ kind: "no-console-errors" });
  }
  const { navigated, finalUrl } = evidence.execution;
  // assert reaching the RIGHT destination (host+path), not just "navigated" — catches a flow
  // that lands on an error/wrong page yet technically navigated.
  if (navigated && finalUrl) out.push({ kind: "navigated", to: destinationKey(finalUrl) });
  else if (navigated) out.push({ kind: "navigated" });
  for (const a of proposed ?? []) {
    if (!a || typeof (a as { kind?: unknown }).kind !== "string") {
      if (a) onDrop?.(a as Assertion, "malformed proposal (no kind)");
      continue;
    }
    if (a.kind === "request-status") {
      // grounding: keep only if a real captured request matches this URL + status.
      const match = evidence.logic.requests.find(
        (r) => r.url.includes(a.urlIncludes) && r.status === a.status,
      );
      // #105: when the proving request is a mutation, freeze its method too — a same-prefix GET
      // must not satisfy the check at replay (parity with step-level expect capture).
      if (match)
        out.push(
          isMutation(match.method)
            ? {
                kind: "request-status",
                urlIncludes: a.urlIncludes,
                status: a.status,
                method: match.method.toUpperCase(),
              }
            : { kind: "request-status", urlIncludes: a.urlIncludes, status: a.status },
        );
      else onDrop?.(a, `no captured request matched ${a.urlIncludes} → ${a.status}`);
    } else if (a.kind === "expect") {
      if (semantic && typeof a.criterion === "string" && a.criterion.trim()) {
        out.push({ kind: "expect", criterion: a.criterion.trim() });
      } else if (!semantic) {
        onDrop?.(a, "semantic checks are off — expect needs an LlmCritic at replay");
      } else {
        onDrop?.(a, "malformed proposal (empty criterion)");
      }
    } else if (a.kind === "navigated" || a.kind === "no-failed-requests" || a.kind === "no-console-errors") {
      // These are grounded by the defaults above; a proposal only matters when the default did
      // NOT hold — that's a real drop the trace should carry, not silence.
      if (!out.some((o) => o.kind === a.kind))
        onDrop?.(
          a,
          a.kind === "navigated" ? "the run did not navigate" : `${a.kind} did not hold during discovery`,
        );
    } else {
      onDrop?.(a, `unknown proposed kind "${(a as { kind: string }).kind}"`);
    }
  }
  // Everything grounded here — defaults, kept proposals, semantic expects — is engine-derived,
  // never the user's own criterion; stamp provenance so a trace/report can tell them apart
  // (spec/core/trace.md). The suite stamps its merged criteria `user` at the same freeze.
  return dedupeAssertions(out.map((a): Assertion => ({ ...a, origin: "derived" })));
}

/** Did discovery observe a request failure that actually counts — neither benign noise
 * (built-in + product list) nor a transient the app retried and recovered? Mirrors the
 * critic's `no-failed-requests` judgment (#66) so freeze and verdict can't drift. */
function sawRequestFailure(
  requests: readonly NetworkRequest[],
  benign: readonly string[],
): boolean {
  return requests.some(
    (r, i) => r.status >= 400 && !isBenignRequest(r.url, benign) && !isRecoveredFailure(requests, i),
  );
}

/** Did discovery observe any console error? Symmetric with `sawRequestFailure` — the freeze
 * carries `no-console-errors` only when the check held during the observed run. (The replay-time
 * critic additionally filters a product's `benignConsole` list — #66.) */
function sawConsoleErrors(console: readonly ConsoleMessage[]): boolean {
  return console.some((m) => m.type === "error");
}

/** Drop duplicate assertions (e.g. a proposed request-status the LLM listed twice). */
function dedupeAssertions(assertions: Assertion[]): Assertion[] {
  const seen = new Set<string>();
  return assertions.filter((a) => {
    const key = JSON.stringify(a);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const ASSERT_SYSTEM =
  "You propose verification assertions for a QA scenario, grounded ONLY in the observed evidence — " +
  "never invent a request or page that is not shown. Given the intent and what the run observed, " +
  "return a JSON array of assertions confirming the intent was achieved. " +
  "Prove the ACTION, not just the destination: prefer a " +
  '{"kind":"request-status","urlIncludes":"<url-substring>","status":200} on the state-changing request ' +
  "that performed the goal (a POST/PUT/PATCH such as an order/submit/create call) — NOT a page navigation " +
  "or GET, which a mere URL jump could satisfy without doing the work. " +
  'Add {"kind":"navigated","to":"<host+path>"} for the destination too. ' +
  "Return [] only if no meaningful action was observed. JSON array only, no prose, no code fences.";

const ASSERT_SYSTEM_SEMANTIC =
  ' You may also add {"kind":"expect","criterion":"<natural-language success criterion>"} ' +
  "for a check no mechanical assertion captures (judged later by an LLM critic).";

/** Compact evidence rendering for the assertion-proposal prompt. */
function renderEvidence(evidence: Evidence): string {
  const { execution, logic } = evidence;
  const requests = logic.requests
    .slice(0, 40)
    .map((r) => `${r.status} ${r.method} ${r.url}`)
    .join("\n");
  // Surface successful mutations separately — these are what prove an action happened (a checkout
  // POST, etc.), so the model grounds the success check on the work, not a page load.
  const mutations = logic.requests
    .filter((r) => isMutation(r.method) && r.status < 400)
    .map((r) => `${r.status} ${r.method} ${r.url}`);
  const errors = logic.console.filter((m) => m.type === "error").map((m) => m.text);
  return [
    `finalUrl: ${execution.finalUrl ?? "(none)"} (navigated: ${execution.navigated})`,
    `state-changing requests that prove an action (prefer one of these): ${
      mutations.length ? "\n" + mutations.join("\n") : "(none)"
    }`,
    `all requests (${logic.requests.length}):`,
    requests || "(none)",
    `console errors (${errors.length}): ${errors.slice(0, 5).join(" | ") || "(none)"}`,
  ].join("\n");
}

/**
 * #16 — at the end of discover, ask the LLM to propose intent-grounded assertions so the freeze
 * carries meaningful checks beyond the default network guard ("passed but wrong"). The proposal is
 * grounded by `deriveAssertions`, so a hallucinated check is dropped and replay stays deterministic.
 */
export async function proposeAssertions(
  llm: LlmClient,
  intent: string,
  evidence: Evidence,
  semantic: boolean,
): Promise<Assertion[]> {
  const system = semantic ? ASSERT_SYSTEM + ASSERT_SYSTEM_SEMANTIC : ASSERT_SYSTEM;
  const prompt = [
    `Intent: ${intent}`,
    ``,
    `Observed evidence:`,
    renderEvidence(evidence),
    ``,
    `Propose the verification assertions. JSON array only.`,
  ].join("\n");
  try {
    const reply = await llm.complete(prompt, { system });
    return extractJsonArray(reply);
  } catch {
    return [];
  }
}

/** First balanced [...] array in a model reply, tolerant of fences/prose; [] on failure. */
function extractJsonArray(text: string): Assertion[] {
  const arr = extractFirstJsonArray(text);
  return Array.isArray(arr) ? (arr as Assertion[]) : [];
}
