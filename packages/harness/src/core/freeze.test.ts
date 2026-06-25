import { describe, expect, it } from "vitest";
import { scoreScenario, scoreTarget, weakTargets } from "./freeze.js";
import type { Scenario } from "./types.js";

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
