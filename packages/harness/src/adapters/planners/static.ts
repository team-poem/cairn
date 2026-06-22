/** Deterministic Planner — returns a fixed scenario. The replay path's planner, no LLM (invariant #4). */
import type { Planner } from "../../core/ports.js";
import type { Context, Scenario } from "../../core/types.js";

export class StaticPlanner implements Planner {
  constructor(private readonly scenario: Scenario) {}

  async plan(_ctx: Context): Promise<Scenario> {
    return this.scenario;
  }
}
