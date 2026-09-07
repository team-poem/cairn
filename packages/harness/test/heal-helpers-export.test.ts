import { describe, expect, it } from "vitest";
import * as node from "../src/index.js";
import * as browser from "../src/browser.js";
import type { ExecutedAction, Verdict } from "../src/index.js";

// #195: a host that runs its own re-discovery (own entry point, step cap, or policy) must judge a
// repair by the same rules the built-in heal uses, or it rewrites `verdict.passed ? repaired :
// undefined` and throws away a repair that found the path because a guard tripped on the way.
const verdict: Verdict = {
  passed: false,
  results: [
    { assertion: { kind: "navigated", to: "shop.co/done" }, passed: true },
    { assertion: { kind: "request-status", urlIncludes: "/api/orders", status: 200 }, passed: false },
    { assertion: { kind: "no-failed-requests" }, passed: false },
    { assertion: { kind: "no-console-errors" }, passed: false },
  ],
};

describe.each([
  ["cairn-engine", node],
  ["cairn-engine/browser", browser],
])("%s exports the heal-correctness helpers (#195)", (_entry, api) => {
  it("goalFailures leaves out the app-health guards", () => {
    expect(api.goalFailures(verdict).map((r) => r.assertion.kind)).toEqual(["request-status"]);
  });

  it("finalizeVerdict fails closed on an incomplete run and keeps the critic's detail", () => {
    const green: Verdict = { passed: true, results: [], detail: "all vacuous" };
    expect(api.finalizeVerdict(green)).toBe(green);
    expect(api.finalizeVerdict(green, "ended before done")).toEqual({
      passed: false, results: [], detail: "all vacuous; ended before done",
    });
  });

  it("blockedReason names the blocked step and how many never ran", () => {
    const actions: ExecutedAction[] = [
      { step: { kind: "goto", url: "https://shop.co/" }, ok: true },
      { step: { kind: "click", target: { text: "Buy" } }, ok: false, error: "no match for Buy" },
    ];
    expect(api.blockedReason(actions, 4)).toBe("step 2/4 blocked: no match for Buy (2 later step(s) never ran)");
    expect(api.blockedReason(actions.slice(0, 1), 1)).toBeUndefined();
  });
});
