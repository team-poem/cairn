/**
 * Deterministic Planner: returns a fixed scenario the caller already built.
 *
 * This is the replay-path planner — no LLM (invariant #4). Discovering a *new* scenario
 * from an unknown app is a different Planner implementation (an LLM loop), not this one.
 */
import type { Planner } from "../interfaces.js";
import type { Context, Scenario } from "../types.js";

export class StaticPlanner implements Planner {
  constructor(private readonly scenario: Scenario) {}

  async plan(_ctx: Context): Promise<Scenario> {
    return this.scenario;
  }
}
