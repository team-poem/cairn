import { describe, expect, it } from "vitest";
import { droppedProofReason, guessedKeyRuns, scoreScenario, scoreTarget, weakTargets } from "../../src/core/freeze.js";
import type { TraceEvent } from "../../src/core/trace.js";
import type { Scenario } from "../../src/core/types.js";

describe("scoreTarget", () => {
  it("selector is strongest and not weak", () => {
    const s = scoreTarget({ selector: "#submit" });
    expect(s.score).toBe(1);
    expect(s.weak).toBe(false);
  });

  it("role + index is resilient (with or without text)", () => {
    expect(scoreTarget({ role: "button", index: 0 }).weak).toBe(false);
    expect(scoreTarget({ text: "Submit", role: "button", index: 0 }).weak).toBe(false);
  });

  it("text-only is weak — a rename would force a self-heal", () => {
    const s = scoreTarget({ text: "Submit" });
    expect(s.weak).toBe(true);
    expect(s.reason).toMatch(/text-only/);
  });

  it("no locator is weak", () => {
    expect(scoreTarget({}).weak).toBe(true);
  });

  it("text + nth is not weak — the designed address for duplicate labels (#92)", () => {
    const s = scoreTarget({ text: "Accept", role: "button", nth: 2 });
    expect(s.weak).toBe(false);
    expect(s.score).toBeGreaterThan(scoreTarget({ text: "Accept" }).score);
    expect(s.score).toBeLessThan(scoreTarget({ role: "button", index: 2 }).score);
    expect(s.reason).toMatch(/nth/);
  });

  it("nth without text locates nothing extra — the remaining locators still decide the score", () => {
    expect(scoreTarget({ nth: 2 }).weak).toBe(true);
    expect(scoreTarget({ role: "button", index: 1, nth: 2 }).score).toBe(0.7); // index fallback still rules
  });
});

describe("weakTargets / scoreScenario", () => {
  const scenario: Scenario = {
    name: "x",
    steps: [
      { kind: "goto", url: "https://x" },
      { kind: "click", target: { text: "Weak" } }, // weak (text-only)
      { kind: "click", target: { text: "Strong", role: "button", index: 1 } }, // ok
      { kind: "type", target: { selector: "#email" }, text: "a@b" }, // ok
      { kind: "pressKey", key: "Enter" }, // no target
    ],
    assertions: [],
  };

  it("scores only the located steps", () => {
    expect(scoreScenario(scenario)).toHaveLength(3);
  });

  it("flags the text-only target with its step index", () => {
    const weak = weakTargets(scenario);
    expect(weak).toHaveLength(1);
    expect(weak[0]!.stepIndex).toBe(1);
  });
});

describe("guessedKeyRuns (#61)", () => {
  const base = (steps: Scenario["steps"]): Scenario => ({ name: "t", steps, assertions: [] });

  it("flags a Tab chain and a multi-key run", () => {
    const s = base([
      { kind: "type", target: { text: "Title" }, text: "hi" },
      { kind: "pressKey", key: "Tab" },
      { kind: "pressKey", key: "1" },
      { kind: "click", target: { text: "Save" } },
      { kind: "pressKey", key: "Tab" },
    ]);
    expect(guessedKeyRuns(s)).toEqual([
      { startIndex: 1, keys: ["Tab", "1"] },
      { startIndex: 4, keys: ["Tab"] },
    ]);
  });

  it("does not flag a single Enter submit after typing (normal pattern)", () => {
    const s = base([
      { kind: "type", target: { text: "Search" }, text: "q" },
      { kind: "pressKey", key: "Enter" },
    ]);
    expect(guessedKeyRuns(s)).toEqual([]);
  });
});

describe("droppedProofReason", () => {
  const gate = (action: string | undefined, gateName = "grounding"): TraceEvent =>
    ({ seq: 1, ts: 0, kind: "gate", payload: { gate: gateName, action, reason: "why" } }) as TraceEvent;

  it("reports a dropped request-status proposal — the freeze may prove nothing without it", () => {
    expect(droppedProofReason(gate('{"kind":"request-status","urlIncludes":"/api/x","status":200}'))).toBe("why");
  });

  it("stays quiet on routine drops (an expect without --semantic)", () => {
    expect(droppedProofReason(gate('{"kind":"expect","criterion":"looks right"}'))).toBeUndefined();
  });

  it("stays quiet on another gate and on a gate carrying no action", () => {
    expect(droppedProofReason(gate('{"kind":"request-status"}', "policy"))).toBeUndefined();
    expect(droppedProofReason(gate(undefined))).toBeUndefined();
  });

  it("stays quiet on an unparseable action instead of throwing", () => {
    expect(droppedProofReason(gate("{not json"))).toBeUndefined();
  });

  it("ignores events that are not gates", () => {
    expect(droppedProofReason({ seq: 0, ts: 0, kind: "run-end", payload: { passed: true } } as TraceEvent)).toBeUndefined();
  });
});
