/** Simplest ContextProvider: the task string is the intent. */
import type { ContextProvider } from "../interfaces.js";
import type { Context } from "../types.js";

export class InlineContextProvider implements ContextProvider {
  constructor(private readonly baseUrl?: string) {}

  async provide(task: string): Promise<Context> {
    return { intent: task, baseUrl: this.baseUrl };
  }
}
