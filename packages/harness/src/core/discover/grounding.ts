/**
 * Freeze-time assertion grounding (#16): the LLM proposes intent-based checks, and everything frozen
 * is verified against the observed evidence — a hallucinated check is dropped, so replay stays
 * deterministic (invariant #4).
 */
import type { LlmClient } from "../ports.js";
import type { Assertion, ConsoleMessage, Evidence, NetworkRequest } from "../types.js";
import { findRequestStatus, isBenignRequest, isMutation, isRecoveredFailure } from "../requests.js";
import { urlReached } from "../steps.js";
import type { UrlMatchOptions } from "../steps.js";
import { extractFirstJsonArray } from "../json.js";
import {
  destinationKey,
  hasStablePath,
  namesAPage,
  sameEndpointShape,
  stableDestination,
  stableEndpointPrefix,
} from "./capture.js";

/**
 * Stamp assertions the STARTING state already satisfies (#137), judged against the baseline
 * evidence captured right after the entry goto — before any flow action. `request-status` is the
 * strongest case: the request log only grows, so a check a landing-page request satisfied can
 * never fail at replay. `navigated` is vacuous when its destination already matches the entry
 * URL. The guards (`no-failed-requests` / `no-console-errors`) hold on any clean start — they
 * carry the flag so a guards-only scenario fails closed at replay, but a flow action can still
 * break them, so they are not individually warned on. `expect`/`custom` need a judge the freeze
 * doesn't have and are never flagged.
 */
export function markVacuous(
  assertions: Assertion[],
  baseline: Evidence,
  benign: readonly string[] = [],
  /** The consumer's locale list — the same one the verdict judges `navigated` with. Judging vacuity
   * under the engine defaults instead cuts both ways: an injected prefix makes a check the entry
   * page already satisfies look discriminating, and a run the consumer would call reached gets
   * stamped as one that was not. */
  urlMatch: UrlMatchOptions = {},
): Assertion[] {
  return assertions.map((a) =>
    isVacuousOn(a, baseline, benign, urlMatch) ? { ...a, vacuous: true as const } : a,
  );
}

function isVacuousOn(
  a: Assertion,
  baseline: Evidence,
  benign: readonly string[],
  urlMatch: UrlMatchOptions = {},
): boolean {
  switch (a.kind) {
    case "request-status":
      return (
        findRequestStatus(baseline.logic.requests, a.urlIncludes, a.status, a.method) !== undefined
      );
    case "navigated":
      return a.to !== undefined && urlReached(baseline.execution.finalUrl ?? "", a.to, urlMatch);
    case "no-failed-requests":
      return !sawRequestFailure(baseline.logic.requests, benign);
    case "no-console-errors":
      return !sawConsoleErrors(baseline.logic.console);
    case "expect":
    case "custom":
      return false;
  }
}

/**
 * Ground the frozen scenario's assertions in what actually happened, not what the LLM
 * guessed — it would propose `navigated` even on a SPA that never navigates, making every
 * replay fail. Always check requests; add `navigated` only if the run truly navigated;
 * keep a proposed `request-status` ONLY if a captured request actually matches it (so a
 * hallucinated check can't fail every replay), frozen as that request's stable endpoint prefix
 * rather than the proposed substring (#172 — a run-specific id in the proposal would never
 * match again). `expect` (LLM-judged) is frozen only when
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
  // that lands on an error/wrong page yet technically navigated. Run-minted segments are frozen as
  // wildcards (#172's shape on this path): an order-confirmation URL carries the order id, and
  // freezing that id makes every later replay miss a destination it actually reached.
  // A destination whose segments are all wildcards (an app whose first path segment is the id) is
  // reached by the error page and the login redirect too — the very thing this check exists to
  // catch — so it degrades to the bare form rather than freezing a check that proves nothing. The
  // refusal happens HERE, at freeze, the way the request path refuses a host-only URL; leaving it
  // to the matcher would bury an unsatisfiable assertion in the skill with no reason recorded.
  const destination = finalUrl ? stableDestination(finalUrl) : undefined;
  if (navigated && destination && namesAPage(destination)) out.push({ kind: "navigated", to: destination });
  // The degraded form is stamped `vacuous` on the spot. "Something navigated" cannot tell a wrong
  // page from the right one, so leaving it unstamped would hand the all-vacuous gate (#137) a live
  // assertion it should never have counted — trading an unsatisfiable check for a green run. It
  // carries its own reason, because the flow DID navigate and reporting it as "nothing changed"
  // sends a reader looking in the wrong place. A bare `navigated` the MODEL proposed is a different
  // thing and is not stamped here.
  else if (navigated && destination)
    out.push({ kind: "navigated", vacuous: true, vacuousBecause: "no-destination" });
  else if (navigated) out.push({ kind: "navigated" });
  for (const a of proposed ?? []) {
    if (!a || typeof (a as { kind?: unknown }).kind !== "string") {
      if (a) onDrop?.(a as Assertion, "malformed proposal (no kind)");
      continue;
    }
    if (a.kind === "request-status") {
      // Only a settled SUCCESS can prove an action. Under 200 means unsettled — 0 is a request
      // still in flight when the freeze ran (`observeOutcomes` waits, but only to its timeout) —
      // and 400+ would freeze the app's failure as the success condition, so replay would demand
      // that the order API keep answering 500. This is the range the step-level expect has always
      // required; a deliberate check on an error response is a user criterion, not a derived one.
      if (typeof a.status !== "number" || a.status < 200 || a.status >= 400) {
        onDrop?.(a, `status ${a.status} is not a settled success`);
        continue;
      }
      // grounding: keep only if a real captured request matches this URL + status (+ method, when
      // the proposal names one — `findRequestStatus` is the predicate the critic judges with, so
      // freeze and verdict ask one question). Without it a `GET /api/jobs 200` would answer a
      // proposal that asked for a POST.
      const match = groundingMatch(evidence.logic.requests, a, benign);
      if (!match) {
        // Say WHICH way it failed. "Nothing matched" sends a reader looking for a request that was
        // there — it was only set aside as noise, which is a different thing to fix.
        const setAside = evidence.logic.requests.some(
          (r) => isBenignRequest(r.url, benign) && r.url.includes(a.urlIncludes) && r.status === a.status,
        );
        const asked = `${a.urlIncludes} → ${a.status}${a.method ? ` (${a.method.toUpperCase()})` : ""}`;
        onDrop?.(
          a,
          setAside
            ? `the only request matching ${asked} is on an endpoint marked benign`
            : `no captured request matched ${asked}`,
        );
        continue;
      }
      // #172: freeze the matching request's STABLE prefix, never the proposed substring. When one
      // action POST fires twice in a run the model tells the two apart by full URL, so the proposal
      // carries a run-specific query/id that no replay can ever produce again — a permanent false
      // FAIL, and outcome-heal cannot escape it (it re-judges against these same pinned assertions).
      // Matching still uses the proposal; only what is frozen is normalized.
      //
      // The collapsing this causes in `dedupeAssertions` is wider than "two firings of one action":
      // when the id sits before the verb, `/api/orders/111/confirm` and `/api/orders/222/cancel`
      // both cut to `host/api/orders` and merge, so a scenario meant to prove a confirm is
      // satisfied by a cancel. Pinned as a counter-example in the corpus tests.
      const urlIncludes = stableEndpointPrefix(match.url);
      // Nothing but the host survived (the first path segment is itself an id): a host-only check
      // would be satisfied by ANY request to that host — a false GREEN, worse than the missing
      // check. Drop it; the trace carries the reason.
      if (!hasStablePath(urlIncludes)) {
        onDrop?.(a, `no stable path in ${match.url} — a host-only check would pass on any request`);
        continue;
      }
      // #105: freeze the method whenever the check should bind to one — the proposal's if it named
      // one (an explicit GET must not be silently widened into "any verb"), otherwise the matching
      // request's when that request is a mutation, so a same-prefix read cannot satisfy a check
      // written for a write.
      const method = a.method?.toUpperCase() ?? (isMutation(match.method) ? match.method.toUpperCase() : undefined);
      // Normalizing widens the check. That is the point when the extra matches are the same action
      // (one POST fired twice, told apart by a run-minted id), and a loss when they are not: a
      // read-only flow proposing `/api/products/586738` freezes `shop.co/api/products`, which the
      // page's own list request already satisfies, so a replay that never opens the detail passes.
      // Freezing a check the evidence itself shows to be undiscriminating trades a loud failure for
      // a silent pass, so drop it and say why. The collision is judged against the METHOD about to
      // be frozen: a POST-bound check is not spent by a `GET …/status` that could never satisfy it.
      const spent = evidence.logic.requests.find(
        (r) =>
          r.url.includes(urlIncludes) &&
          r.status === a.status &&
          (!method || r.method.toUpperCase() === method) &&
          !sameEndpointShape(r.url, match.url) &&
          !isBenignRequest(r.url, benign),
      );
      if (spent) {
        onDrop?.(
          a,
          `${urlIncludes} would also match ${spent.method} ${spent.url}, which is a different endpoint than the one proposed`,
        );
        continue;
      }
      out.push(
        method
          ? { kind: "request-status", urlIncludes, status: a.status, method }
          : { kind: "request-status", urlIncludes, status: a.status },
      );
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
      const grounded = out.find((o) => o.kind === a.kind);
      if (!grounded)
        onDrop?.(
          a,
          a.kind === "navigated" ? "the run did not navigate" : `${a.kind} did not hold during discovery`,
        );
      // The observed destination wins — but a model that expected the success page while the run
      // sat on an error page is exactly what a reader needs to see, and silently replacing one with
      // the other is the kind of substitution `onDrop` exists to surface.
      else if (
        a.kind === "navigated" &&
        a.to &&
        grounded.kind === "navigated" &&
        // `urlReached`, not string equality: the frozen value is normalized while the proposal may
        // carry a scheme or a trailing slash, and a signal that cries on formatting is one readers
        // learn to skip. Same predicate the verdict uses, so trace and judgment agree.
        !(grounded.to !== undefined && urlReached(grounded.to, a.to))
      )
        onDrop?.(a, `the run reached ${grounded.to ?? "no recorded destination"}, not ${a.to}`);
    } else {
      onDrop?.(a, `unknown proposed kind "${(a as { kind: string }).kind}"`);
    }
  }
  // Everything grounded here — defaults, kept proposals, semantic expects — is engine-derived,
  // never the user's own criterion; stamp provenance so a trace/report can tell them apart
  // (spec/core/trace.md). The suite stamps its merged criteria `user` at the same freeze.
  return dedupeAssertions(out.map((a): Assertion => ({ ...a, origin: "derived" })));
}

/**
 * The captured request a proposal is grounded on. With a method named, that method is required.
 * Without one — which is the common case, since the prompt's example JSON carries no `method` — a
 * MUTATION match is preferred over a read: the prompt asks the model to prove the action with the
 * state-changing request, and picking by arrival order instead would let the network decide whether
 * the frozen check binds to a verb (the same evidence freezing differently run to run).
 */
function groundingMatch(
  requests: readonly NetworkRequest[],
  a: Assertion & { kind: "request-status" },
  benign: readonly string[],
): NetworkRequest | undefined {
  // Noise cannot prove an action. For `no-failed-requests`, `benign` means "its failure does not
  // count"; for a proof it means the opposite — a product marks an endpoint benign precisely
  // because it is incidental, and standing a tracking beacon up as the evidence an order was placed
  // inverts that. Worse, such a check also counts as a proof and disarms the unproven-action gate.
  const candidates = requests.filter((r) => !isBenignRequest(r.url, benign));
  if (a.method) return findRequestStatus(candidates, a.urlIncludes, a.status, a.method);
  const mutation = candidates.find(
    (r) => isMutation(r.method) && r.url.includes(a.urlIncludes) && r.status === a.status,
  );
  return mutation ?? findRequestStatus(candidates, a.urlIncludes, a.status);
}

/**
 * Did the run perform an action that the freeze could not express a check for? True only when BOTH
 * hold: no `request-status` proof survived grounding, and the FLOW (not the entry page load — see
 * `sinceRequest`) fired a successful, non-benign mutation whose URL `hasStablePath` rejects — the
 * SAME predicate grounding refuses a check with. Sharing it is the point: a gate that asks a
 * different question than the refusal it exists to cover leaves the gap between the two answers
 * passing silently, which is the failure this rule is for.
 *
 * The cost is that background traffic of the same shape arms it too — a transport that mounts its
 * session under a run-minted first segment (`/123/abc/xhr_send`) reads exactly like an unprovable
 * action. That is loud and fixable from the outside: the product marks the endpoint `benign`, the
 * seam this engine already uses for app-specific noise rather than guessing at it.
 *
 * The proof half is deliberately coarse and this is its limit: ANY surviving proof disarms the gate,
 * including one belonging to a different action than the unexpressible mutation. Pairing a proof to
 * the action it proves is a larger change (see the PR discussion), so the gate under-fires there.
 */
export function hasUnprovenAction(
  evidence: Evidence,
  assertions: readonly Assertion[],
  benign: readonly string[] = [],
  /** Index into the cumulative request log where the flow's own traffic starts — everything the
   * entry page load fired is excluded, the same separation `markVacuous` makes with the baseline. */
  sinceRequest = 0,
): boolean {
  if (assertions.some((a) => a.kind === "request-status" && a.vacuous !== true)) return false;
  return evidence.logic.requests
    .slice(sinceRequest)
    .some(
      (r) =>
        isMutation(r.method) &&
        r.status >= 200 &&
        r.status < 400 &&
        !isBenignRequest(r.url, benign) &&
        !hasStablePath(stableEndpointPrefix(r.url)),
    );
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
    // `>= 200` keeps an in-flight request (status 0) out of the list the prompt tells the model to
    // prefer — otherwise the freeze is invited to prove an action with a request that never landed.
    .filter((r) => isMutation(r.method) && r.status >= 200 && r.status < 400)
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
