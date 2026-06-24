/** Deterministic Planner — returns a fixed scenario. The replay path's planner, no LLM (invariant #4). */
import type { Planner } from "../../core/ports.js";
import type { Context, Scenario } from "../../core/types.js";

export class StaticPlanner implements Planner {
  constructor(private readonly scenario: Scenario) {}

  async plan(ctx: Context): Promise<Scenario> {
    // A custom ContextProvider can relabel the run through intent; on the default
    // replay path the task is scenario.name, so intent === name and this is a no-op.
    return { ...this.scenario, name: ctx.intent || this.scenario.name };
  }
}
