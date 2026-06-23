/**
 * Execute-stage step handlers (invariant #2). The pipeline routes each Step to the first
 * handler that `supports` it (DispatcherServlet-style) — built-in kinds and product-defined
 * `custom` actions resolve through the same `StepHandler` seam, so adding an action means
 * registering a handler, never editing a stage. Depends only on core ports/types.
 */
import type { CustomAction, Driver, StepHandler } from "./ports.js";
import type { Step } from "./types.js";

/** Handles cairn's built-in step vocabulary — every kind except product-defined `custom`. */
export class BuiltinStepHandler implements StepHandler {
  supports(step: Step): boolean {
    return step.kind !== "custom";
  }

  async execute(step: Step, driver: Driver): Promise<void> {
    switch (step.kind) {
      case "goto":
        return driver.goto(step.url);
      case "click":
        return driver.click(step.target);
      case "doubleClick":
        return driver.doubleClick(step.target);
      case "hover":
        return driver.hover(step.target);
      case "type":
        return driver.type(step.target, step.text);
      case "select":
        return driver.select(step.target, step.value);
      case "pressKey":
        return driver.pressKey(step.key);
      case "scroll":
        return driver.scroll(step.direction);
      case "custom":
        // Owned by CustomStepHandler; reaching here means a handler-ordering bug, not bad input.
        throw new Error(`built-in handler received custom step "${step.name}"`);
      default: {
        // Exhaustiveness guard: a new Step kind that no case handles fails to compile here.
        const unhandled: never = step;
        throw new Error(`unhandled step kind: ${JSON.stringify(unhandled)}`);
      }
    }
  }
}

/** Handles product-defined `{ kind: "custom", name }` steps via a name→action registry. */
export class CustomStepHandler implements StepHandler {
  constructor(private readonly actions: Record<string, CustomAction> = {}) {}

  supports(step: Step): boolean {
    return step.kind === "custom";
  }

  async execute(step: Step, driver: Driver): Promise<void> {
    if (step.kind !== "custom") throw new Error(`custom handler received "${step.kind}" step`);
    const action = this.actions[step.name];
    if (!action) throw new Error(`no handler registered for custom action "${step.name}"`);
    await action(driver, step.params ?? {});
  }
}

/** The engine's default Execute-stage chain: built-ins first, then product `custom` actions. */
export function defaultStepHandlers(actions: Record<string, CustomAction> = {}): StepHandler[] {
  return [new BuiltinStepHandler(), new CustomStepHandler(actions)];
}
