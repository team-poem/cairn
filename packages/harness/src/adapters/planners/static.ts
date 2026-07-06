/** Deterministic Planner — returns a fixed scenario. The replay path's planner, no LLM (invariant #4). */
import type { Planner } from "../../core/ports.js";
import type { Context, Scenario } from "../../core/types.js";

export class StaticPlanner implements Planner {
  constructor(private readonly scenario: Scenario) {}

  async plan(_ctx: Context): Promise<Scenario> {
    // scenario.name is the frozen identity; the run's intent lives in result.context.intent —
    // one home each, so a custom ContextProvider can't relabel the scenario (#13).
    return this.scenario;
  }
}
