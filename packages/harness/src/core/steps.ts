/**
 * Execute-stage step handlers (invariant #2). The pipeline routes each Step to the first
 * handler that `supports` it (DispatcherServlet-style) — built-in kinds and product-defined
 * `custom` actions resolve through the same `StepHandler` seam, so adding an action means
 * registering a handler, never editing a stage. Depends only on core ports/types.
 */
import type { CustomAction, Driver, StepHandler } from "./ports.js";
import type { Step, WaitUntil } from "./types.js";
import { findRequestStatus } from "./requests.js";

const WAIT_POLL_MS = 200;
const WAIT_TIMEOUT_MS = 10_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// host + path, dropping a leading locale segment (…/en, …/ko, …/en-US) — locale prefixes vary by
// environment/user, so they must not affect matching. Host is kept, not guessed away.
function localeStrippedKey(u: string): string {
  let host: string, path: string;
  try {
    const x = new URL(u);
    host = x.host;
    path = x.pathname;
  } catch {
    const s = u.replace(/^https?:\/\//, "").replace(/[?#].*$/, "");
    const i = s.indexOf("/");
    host = i === -1 ? s : s.slice(0, i);
    path = i === -1 ? "" : s.slice(i);
  }
  const segs = path.split("/").filter(Boolean);
  if (segs[0] && /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/.test(segs[0])) segs.shift();
  const p = segs.join("/");
  return host ? (p ? `${host}/${p}` : host) : p;
}

/** Whether `finalUrl` reached `want`, matched at a path boundary (not raw substring) and
 * locale-agnostic — so a parent path ("…/en") never counts as reaching "…/en/signin", and a
 * differing locale still matches. `want` may be a full host+path or a bare suffix. */
export function urlReached(finalUrl: string, want: string): boolean {
  const dest = localeStrippedKey(finalUrl);
  const w = localeStrippedKey(want);
  return dest === w || dest.endsWith("/" + w);
}

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
      case "waitFor":
        return waitForCondition(driver, step.until, step.timeoutMs);
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

/**
 * Poll the Driver's own observation until every field of `until` holds, or throw on timeout.
 * Uses only `observe()`/`snapshot()`, so any Driver works and replay stays deterministic (no LLM,
 * invariant #4). This is the explicit-wait primitive the heuristic `settle()` can't express —
 * e.g. "wait until /me returns 200" before the next step, instead of racing the app's readiness.
 */
export async function waitForCondition(
  driver: Driver,
  until: WaitUntil,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await conditionMet(driver, until)) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${JSON.stringify(until)}`);
    }
    await sleep(WAIT_POLL_MS);
  }
}

/** Whether every field of `until` holds now (Driver observation only, no LLM). Polled by `waitFor`
 * and checked once per step for `expect` verification (spec/core/surgical-heal.md). */
export async function conditionMet(driver: Driver, until: WaitUntil): Promise<boolean> {
  if (until.url !== undefined || until.requestStatus !== undefined) {
    const { execution, logic } = await driver.observe();
    if (until.url !== undefined && !urlReached(execution.finalUrl ?? "", until.url)) return false;
    if (until.requestStatus) {
      const { urlIncludes, status } = until.requestStatus;
      if (!findRequestStatus(logic.requests, urlIncludes, status)) return false;
    }
  }
  if (until.text !== undefined) {
    const needle = until.text.trim().toLowerCase();
    const els = await driver.snapshot();
    const hit = els.some(
      (e) => (!until.role || e.role === until.role) && e.name.toLowerCase().includes(needle),
    );
    if (!hit) return false;
  }
  return true;
}
