/**
 * Freeze-time assertion grounding (#16): the LLM proposes intent-based checks, and everything frozen
 * is verified against the observed evidence — a hallucinated check is dropped, so replay stays
 * deterministic (invariant #4).
 */
import type { LlmClient } from "../ports.js";
import type { Assertion, Evidence } from "../types.js";
import { isBenignRequest, isMutation } from "../requests.js";
import { extractFirstJsonArray } from "../json.js";
import { destinationKey } from "./capture.js";

/**
 * Ground the frozen scenario's assertions in what actually happened, not what the LLM
 * guessed — it would propose `navigated` even on a SPA that never navigates, making every
 * replay fail. Always check requests; add `navigated` only if the run truly navigated;
 * keep a proposed `request-status` ONLY if a captured request actually matches it (so a
 * hallucinated check can't fail every replay). `expect` (LLM-judged) is frozen only when
 * `semantic` is set — otherwise the freeze stays deterministic (invariant #4).
 */
export function deriveAssertions(
  proposed: Assertion[] | undefined,
  evidence: Evidence,
  semantic: boolean,
): Assertion[] {
  const out: Assertion[] = [];
  // Ground no-failed-requests: freeze it only if it actually HELD during discovery (no non-benign
  // failure). A flow that survives a noisy 4xx would otherwise fail every replay on a check that was
  // already false — the success-proving request below carries the real signal instead.
  if (!evidence.logic.requests.some((r) => r.status >= 400 && !isBenignRequest(r.url))) {
    out.push({ kind: "no-failed-requests" });
  }
  const { navigated, finalUrl } = evidence.execution;
  // assert reaching the RIGHT destination (host+path), not just "navigated" — catches a flow
  // that lands on an error/wrong page yet technically navigated.
  if (navigated && finalUrl) out.push({ kind: "navigated", to: destinationKey(finalUrl) });
  else if (navigated) out.push({ kind: "navigated" });
  for (const a of proposed ?? []) {
    if (!a || typeof (a as { kind?: unknown }).kind !== "string") continue;
    if (a.kind === "request-status") {
      // grounding: keep only if a real captured request matches this URL + status.
      const matches = evidence.logic.requests.some(
        (r) => r.url.includes(a.urlIncludes) && r.status === a.status,
      );
      if (matches)
        out.push({ kind: "request-status", urlIncludes: a.urlIncludes, status: a.status });
    } else if (a.kind === "expect" && semantic && typeof a.criterion === "string" && a.criterion.trim()) {
      out.push({ kind: "expect", criterion: a.criterion.trim() });
    }
  }
  return dedupeAssertions(out);
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
