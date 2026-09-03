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

/**
 * Locale prefixes eligible for `urlReached`'s locale-stripping FALLBACK. Deliberately small and
 * conservative: "any two-letter first segment is a locale" is a trait of particular apps, not a web
 * fact — promoting it to a heuristic swallowed real routes like /my (#86). Which prefixes are
 * locales is something only the consumer knows, so the set is injectable (`UrlMatchOptions`,
 * surfaced as `RunHarnessOptions.localePrefixes`) — same seam pattern as the benign lists. A region
 * variant matches its base language ("en-US" counts as "en").
 */
export const DEFAULT_LOCALE_PREFIXES: readonly string[] = ["en", "ko", "ja", "jp"];

/** URL-matching knobs — consumer-injected, never guessed from the URL itself. */
export interface UrlMatchOptions {
  /** Does this scenario's frozen data use `*` for a run-minted segment? Set from
   * `Scenario.wildcards`; without it a `*` is matched as the literal character it was frozen as. */
  wildcards?: boolean;
  /** First-path-segment prefixes treated as locales in the stripping fallback.
   * Default: `DEFAULT_LOCALE_PREFIXES`. Pass `[]` to disable the fallback. */
  localePrefixes?: readonly string[];
}

interface HostPath {
  host: string;
  segs: string[];
}

// host + path split, query/hash dropped. `u` may be a full URL or a frozen bare host+path/suffix.
// `new URL()` only for an EXPLICIT http(s) scheme (#87): it doesn't throw on scheme-less values —
// it silently mis-parses them ("localhost:3000/mentor" → scheme "localhost:", empty host, path
// "3000/mentor"), which made every port-bearing frozen destination unreachable at replay.
function splitHostPath(u: string): HostPath {
  if (/^https?:\/\//i.test(u)) {
    try {
      const x = new URL(u);
      return { host: x.host, segs: x.pathname.split("/").filter(Boolean) };
    } catch {
      // malformed despite the scheme — fall through to the manual split
    }
  }
  const s = u.replace(/^https?:\/\//i, "").replace(/[?#].*$/, "");
  const i = s.indexOf("/");
  const host = i === -1 ? s : s.slice(0, i);
  const path = i === -1 ? "" : s.slice(i);
  return { host, segs: path.split("/").filter(Boolean) };
}

function stripLocale(hp: HostPath, prefixes: readonly string[]): HostPath {
  const first = hp.segs[0];
  const isLocale = first !== undefined && prefixes.some((p) => first === p || first.startsWith(p + "-"));
  return isLocale ? { host: hp.host, segs: hp.segs.slice(1) } : hp;
}

// Boundary match (never raw substring): equal, or a suffix starting at a path boundary. Compared
// segment by segment so a frozen `*` stands for exactly one segment — the freeze writes one where
// the run minted the value (an order id in a confirmation URL), and matching it literally would
// fail every later run. A want whose PATH is nothing but wildcards is refused: `shop.co/*` is
// reached by the app's error page and its login redirect alike, which is the opposite of what a
// destination check is for. The test skips the host token deliberately — counting it would let
// `shop.co/*` through, and refusing here rather than only at freeze also covers a hand-written
// target and a skill already on disk.
function boundaryMatch(dest: HostPath, want: HostPath, wildcards: boolean): boolean {
  const wantTokens = tokens(want);
  const destTokens = tokens(dest);
  if (wantTokens.length === 0 || wantTokens.length > destTokens.length) return false;
  if (wildcards) {
    if (want.segs.length > 0 && want.segs.every((t) => t === WILDCARD)) return false;
    if (want.segs.length === 0 && want.host === WILDCARD) return false;
  }
  const tail = destTokens.slice(destTokens.length - wantTokens.length);
  return wantTokens.every((t, i) => (wildcards && t === WILDCARD) || t === tail[i]);
}

/** One segment the run minted, written into a frozen destination in its place. */
export const WILDCARD = "*";

function tokens({ host, segs }: HostPath): string[] {
  return host ? [host, ...segs] : segs;
}

/** Whether `finalUrl` reached `want`, matched at a path boundary (not raw substring) — a parent
 * path ("…/en") never counts as reaching "…/en/signin". `want` may be a full host+path or a bare
 * suffix. Two stages (#86): first a DIRECT match with no locale interpretation — so a real route
 * that merely looks like a locale ("/my", "/go") matches as itself; only when that fails, retry
 * with consumer-approved locale prefixes stripped — so a frozen destination still matches when the
 * environment serves another locale. */
export function urlReached(finalUrl: string, want: string, opts: UrlMatchOptions = {}): boolean {
  const dest = splitHostPath(finalUrl);
  const w = splitHostPath(want);
  const wildcards = opts.wildcards ?? false;
  if (boundaryMatch(dest, w, wildcards)) return true;
  const prefixes = opts.localePrefixes ?? DEFAULT_LOCALE_PREFIXES;
  const strippedDest = stripLocale(dest, prefixes);
  const strippedWant = stripLocale(w, prefixes);
  if (strippedDest === dest && strippedWant === w) return false; // nothing stripped — stage 1 decided
  return boundaryMatch(strippedDest, strippedWant, wildcards);
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
  if (!(await pollCondition(driver, until, timeoutMs))) {
    throw new Error(`waitFor timed out after ${timeoutMs}ms: ${JSON.stringify(until)}`);
  }
}

/**
 * Poll `conditionMet` until it holds or the deadline passes; returns whether it held. The readiness
 * primitive `waitForCondition` and the per-step `expect` check both build on this — a step's
 * post-condition is *waited for*, not checked once, so an async effect (a submit's request landing, a
 * deferred re-render) is caught instead of raced. Returns immediately when the condition already holds.
 */
export interface PollOptions {
  pollMs?: number;
  /** Only count requests at/after this index of the run's request log for `requestStatus` — a
   * per-step watermark, so an earlier step's request can't satisfy this step's post-condition. */
  sinceRequestIndex?: number;
  /** Consumer-injected URL-matching knobs (locale prefixes) for `until.url` (#86). */
  urlMatch?: UrlMatchOptions;
}

export async function pollCondition(
  driver: Driver,
  until: WaitUntil,
  timeoutMs: number,
  opts: PollOptions = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await conditionMet(driver, until, opts.sinceRequestIndex, opts.urlMatch)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(opts.pollMs ?? WAIT_POLL_MS);
  }
}

/** Whether every field of `until` holds now (Driver observation only, no LLM). Polled by `waitFor`
 * and checked once per step for `expect` verification (spec/core/surgical-heal.md). `requestStatus`
 * is event evidence over a cumulative log, so callers verifying a single step pass a watermark. */
export async function conditionMet(
  driver: Driver,
  until: WaitUntil,
  sinceRequestIndex = 0,
  urlMatch: UrlMatchOptions = {},
): Promise<boolean> {
  if (until.url !== undefined || until.requestStatus !== undefined) {
    const { execution, logic } = await driver.observe();
    if (until.url !== undefined && !urlReached(execution.finalUrl ?? "", until.url, urlMatch)) return false;
    if (until.requestStatus) {
      const { urlIncludes, status, method } = until.requestStatus;
      // Same predicate as the request-status assertion (core/requests.ts) — the step watermark
      // is applied by slicing the cumulative log before matching.
      if (!findRequestStatus(logic.requests.slice(sinceRequestIndex), urlIncludes, status, method)) {
        return false;
      }
    }
  }
  if (until.text !== undefined || until.role !== undefined) {
    // A role without text still names a condition: some element of that role must be present.
    // Fail closed: a provided field is never vacuously true.
    const needle = until.text?.trim().toLowerCase();
    const els = await driver.snapshot();
    const hit = els.some(
      (e) =>
        (!until.role || e.role === until.role) &&
        (needle === undefined || e.name.toLowerCase().includes(needle)),
    );
    if (!hit) return false;
  }
  return true;
}
