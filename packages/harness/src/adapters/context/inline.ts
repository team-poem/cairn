/** Simplest ContextProvider: the task string is the intent. */
import type { ContextProvider } from "../../core/ports.js";
import type { Context } from "../../core/types.js";

export class InlineContextProvider implements ContextProvider {
  async provide(task: string): Promise<Context> {
    return { intent: task };
  }
}
