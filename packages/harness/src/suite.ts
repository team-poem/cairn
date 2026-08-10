/**
 * runSuite — the batch entry for user-provided QA cases: a list of natural-language intents with
 * the USER's success criteria. Per case: load the frozen skill, or discover it once and freeze it
 * WITH the user's criteria merged in (discover's own derived assertions only prove what the run
 * did — the user's expected outcome is the point of a test case), then replay deterministically.
 * First run pays discovery; every later run replays a mechanical-only case with llmCalls: 0 —
 * the engine's economics, per case.
 *
 * Assembly layer like `run.ts`: composes core + adapters behind the ports; a host can inject
 * every seam (store, driver factory, llm, policy, reporter).
 */
import { createHash } from "node:crypto";
import { discover } from "./core/discover/index.js";
import type { ActionPolicy } from "./core/discover/index.js";
import { runScenario } from "./run.js";
import type { RunScenarioOptions } from "./run.js";
import { UsageMeter, emptyUsage } from "./core/usage.js";
import { ChromeDevToolsDriver } from "./adapters/drivers/chrome.js";
import { FileSkillStore } from "./adapters/skills/file-store.js";
import { createLlmClient } from "./adapters/llm/factory.js";
import { startTrace } from "./core/trace.js";
import { ENGINE_VERSION } from "./version.js";
import type { TraceEvent, Tracer } from "./core/trace.js";
import type { Driver, LlmClient, Reporter, SkillStore, TraceSink } from "./core/ports.js";
import type { Assertion, RunUsage, Scenario, Verdict } from "./core/types.js";

export interface SuiteCase {
  /** Names the frozen skill (`<skillDir>/<id>.skill.json`) — stable across runs, no path separators. */
  id: string;
  /** What to do, in natural language — discover's input on a cache miss. */
  intent: string;
  /** Case start URL; falls back to `SuiteOptions.baseUrl`. One of the two is required. */
  url?: string;
  /** The USER's success criteria in natural language, frozen as `expect` assertions
   * (LLM-judged at replay — a case with none replays fully deterministically). */
  expect?: string[];
  /** Mechanical assertions the user wants frozen alongside the derived ones. */
  assertions?: Assertion[];
  /** Discover step cap for this case. */
  maxSteps?: number;
}

/** A frozen skill's staleness fingerprint: the case's user-authored inputs (intent + the criteria
 * merged into the freeze) at the time it was discovered. Suite-local extension of `Scenario` — NOT
 * a core type change; `Scenario`/`SkillStore` stay shared with plain discover/replay/CLI (spec §2,
 * pattern ≠ data). An undeclared field rides through `Scenario` objects unchanged (plain JS object
 * spread), so a healed re-freeze that starts from the original scenario keeps its hash for free. */
export type FrozenSuiteScenario = Scenario & { caseHash: string };

/** Fingerprints exactly the case fields that flow into the freeze: `intent`, the criteria
 * (`expect`/`assertions`), and the START URL — discover freezes `url ?? baseUrl` as the first
 * `goto`, so repointing either one changes what replays and must read as stale (#131). `id` and
 * `maxSteps` stay out: file key and step cap, neither changes what was discovered or judged. */
export function hashCase(c: SuiteCase, baseUrl?: string): string {
  const material = JSON.stringify({
    intent: c.intent,
    url: c.url ?? baseUrl,
    expect: c.expect ?? [],
    assertions: c.assertions ?? [],
  });
  return createHash("sha256").update(material).digest("hex");
}

export interface SuiteOptions
  extends Pick<
    RunScenarioOptions,
    | "llm"
    | "model"
    | "benign"
    | "benignConsole"
    | "localePrefixes"
    | "custom"
    | "actions"
    | "signal"
    | "expectTimeoutMs"
    | "screenshots"
  > {
  /** Where frozen skills live. Default: a FileSkillStore with refs under `skillDir`. */
  store?: SkillStore;
  /** Path prefix for the default store's refs. Default "skills". */
  skillDir?: string;
  /** Fallback start URL for cases that don't carry their own. */
  baseUrl?: string;
  /** Repair broken replays (locator + surgical + outcome heal) and re-freeze. Default true —
   * a suite is unattended by design; pass false for a strict regression gate. */
  heal?: boolean;
  /** Builds the browser for each discovery and each replay — a FRESH driver per case isolates
   * case state (auth, storage, dialogs). Default: ChromeDevToolsDriver. The suite closes what
   * this factory returns (#98: whoever constructs owns). */
  driverFactory?: () => Driver;
  /** Per-case result reporter, forwarded to `runScenario`. */
  reporter?: Reporter;
  /** Gate discovered actions — forwarded to discover AND to the heal re-discovery. */
  policy?: ActionPolicy;
  /** Fired after each case with its verdict — a host's live progress feed. */
  onCase?: (verdict: SuiteVerdict) => void;
  /** Lifecycle event stream for the whole suite (spec/core/trace.md): one header, then every
   * case's events under its `caseRef` (= case id), then run-end. */
  trace?: TraceSink;
}

export interface SuiteVerdict {
  id: string;
  intent: string;
  verdict: Verdict;
  skillRef: string;
  /** True when this run had to discover the case (cache miss); false = pure replay. */
  discovered: boolean;
  /** True when discovery hit its step cap — the case failed closed and nothing was frozen. */
  truncated?: boolean;
  /** Locator + surgical step heals the replay needed (0 on a clean replay). */
  heals: number;
  /** Discovery + replay combined. A cached mechanical-only case shows llmCalls: 0. */
  usage: RunUsage;
}

export interface SuiteResult {
  verdicts: SuiteVerdict[];
  /** Every case passed. */
  passed: boolean;
  /** Whole-suite LLM usage. */
  usage: RunUsage;
}

function addUsage(a: RunUsage, b: RunUsage): RunUsage {
  return {
    llmCalls: a.llmCalls + b.llmCalls,
    measuredCalls: a.measuredCalls + b.measuredCalls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

/** Config errors fail the whole suite up front — before any browser or LLM spend. */
function validateCases(cases: SuiteCase[], opts: SuiteOptions): void {
  if (!cases.length) throw new Error("runSuite: empty case list");
  const seen = new Set<string>();
  for (const c of cases) {
    if (!c.id?.trim()) throw new Error("runSuite: every case needs a non-empty id");
    if (/[/\\]|\.\./.test(c.id)) throw new Error(`runSuite: case id "${c.id}" must not contain path separators`);
    if (seen.has(c.id)) throw new Error(`runSuite: duplicate case id "${c.id}"`);
    seen.add(c.id);
    if (!c.intent?.trim()) throw new Error(`runSuite: case "${c.id}" needs an intent`);
    if (!c.url && !opts.baseUrl) throw new Error(`runSuite: case "${c.id}" has no url and no suite baseUrl`);
  }
}

export async function runSuite(cases: SuiteCase[], opts: SuiteOptions = {}): Promise<SuiteResult> {
  validateCases(cases, opts);
  const {
    store = new FileSkillStore(),
    skillDir = "skills",
    heal = true,
    driverFactory = () => new ChromeDevToolsDriver(),
    onCase,
  } = opts;
  // One client for the whole suite (built only if some case needs it); each phase meters it
  // separately so a verdict's usage is exact.
  let llm: LlmClient | undefined = opts.llm;
  const getLlm = (): LlmClient => (llm ??= createLlmClient(opts.model ? { model: opts.model } : {}));

  // One trace for the whole suite: the header goes out before any case, run-end after the last.
  const tracer = opts.trace ? startTrace(opts.trace, ENGINE_VERSION) : undefined;

  const verdicts: SuiteVerdict[] = [];
  for (const c of cases) {
    const verdict = await runCase(c, { ...opts, store, skillDir, heal, driverFactory, getLlm, tracer });
    verdicts.push(verdict);
    onCase?.(verdict);
  }
  const passed = verdicts.every((v) => v.verdict.passed);
  const usage = verdicts.reduce((sum, v) => addUsage(sum, v.usage), emptyUsage());
  tracer?.emit({ kind: "run-end", payload: { passed, usage } });
  return { verdicts, passed, usage };
}

interface CaseContext extends SuiteOptions {
  store: SkillStore;
  skillDir: string;
  heal: boolean;
  driverFactory: () => Driver;
  getLlm: () => LlmClient;
  tracer?: Tracer;
}

/** The suite owns the `freeze` event: `caseHash` and assertion-provenance counts are suite/freeze
 * concepts the core never reads (pattern ≠ data) — so the caller of `store.freeze` reports them. */
function freezePayload(ref: string, s: FrozenSuiteScenario): Extract<TraceEvent, { kind: "freeze" }>["payload"] {
  const count = (o: "user" | "derived" | undefined): number => s.assertions.filter((a) => a.origin === o).length;
  return {
    ref,
    caseHash: s.caseHash,
    assertions: { user: count("user"), derived: count("derived"), unknown: count(undefined) },
    ...(s.truncated ? { truncated: true } : {}),
  };
}

async function runCase(c: SuiteCase, ctx: CaseContext): Promise<SuiteVerdict> {
  const ref = `${ctx.skillDir}/${c.id}.skill.json`;
  const base = { id: c.id, intent: c.intent, skillRef: ref };
  const scope = ctx.tracer?.scope(c.id);
  try {
    // 1. Cache: any load failure (missing, malformed artifact) is a miss — re-discovering IS the
    // repair for a broken skill file.
    let scenario: Scenario | undefined;
    try {
      scenario = await ctx.store.load(ref);
    } catch {
      scenario = undefined;
    }
    // Staleness check (solp721, PR #124): a cache hit only counts on an EXACT caseHash match —
    // editing a case's intent/expect/assertions in cases.json must never silently replay the OLD
    // skill against the NEW criteria. A skill frozen before this check shipped has no caseHash at
    // all; treat that as stale too (forces one re-discover) rather than trusting unverified state —
    // fail-closed like the rest of the engine (#69/#90).
    if (scenario && (scenario as Partial<FrozenSuiteScenario>).caseHash !== hashCase(c, ctx.baseUrl)) {
      scenario = undefined;
    }
    scope?.emit({
      kind: "case-start",
      payload: { id: c.id, intent: c.intent, skillRef: ref, cached: !!scenario },
    });
    let discovered = false;
    let discoveryUsage = emptyUsage();

    // 2. Miss → discover once, merge the USER's criteria, freeze.
    if (!scenario) {
      const meter = new UsageMeter(ctx.getLlm());
      const driver = ctx.driverFactory();
      let found: Scenario;
      try {
        found = await discover(c.intent, {
          driver,
          llm: meter,
          baseUrl: c.url ?? ctx.baseUrl,
          maxSteps: c.maxSteps,
          policy: ctx.policy,
          signal: ctx.signal,
          benign: ctx.benign,
          trace: scope,
        });
      } finally {
        await driver.close().catch(() => {});
      }
      discovered = true;
      discoveryUsage = meter.snapshot();

      if (found.truncated) {
        // Fail closed (same stance as #69/#90): a capped discovery is an unverified path —
        // don't freeze it, don't replay it, don't let it pass.
        const verdict: Verdict = {
          passed: false,
          results: [],
          detail: "discovery truncated at the step cap — unverified path, nothing frozen",
        };
        scope?.emit({
          kind: "case-end",
          payload: { verdict, usage: discoveryUsage, discovered, heals: 0, truncated: true },
        });
        return { ...base, discovered, truncated: true, heals: 0, usage: discoveryUsage, verdict };
      }

      const frozenScenario: FrozenSuiteScenario = {
        ...found,
        // Merged criteria are stamped `origin: "user"` (discover's own carry `"derived"` from
        // deriveAssertions) — so a trace/report can say which greens the USER vouched for
        // (spec/core/trace.md). Note `hashCase` fingerprints the raw case fields, pre-stamp.
        assertions: [
          ...found.assertions,
          ...(c.assertions ?? []).map((a): Assertion => ({ ...a, origin: "user" })),
          ...(c.expect ?? []).map((criterion): Assertion => ({ kind: "expect", criterion, origin: "user" })),
        ],
        caseHash: hashCase(c, ctx.baseUrl),
      };
      scenario = frozenScenario;
      await ctx.store.freeze(ref, scenario);
      scope?.emit({ kind: "freeze", phase: "discover", payload: freezePayload(ref, frozenScenario) });
    }

    // 3. Replay on a fresh driver (case isolation). The suite constructed it → the suite closes it.
    const driver = ctx.driverFactory();
    try {
      const { result, heals, stepHeals, healedScenario } = await runScenario(scenario, {
        driver,
        heal: ctx.heal,
        llm: ctx.llm,
        model: ctx.model,
        reporter: ctx.reporter,
        policy: ctx.policy,
        signal: ctx.signal,
        benign: ctx.benign,
        benignConsole: ctx.benignConsole,
        localePrefixes: ctx.localePrefixes,
        custom: ctx.custom,
        actions: ctx.actions,
        expectTimeoutMs: ctx.expectTimeoutMs,
        // Without this a suite could never produce attachments — and a suite is where the traces
        // that get audited come from (#160).
        screenshots: ctx.screenshots,
        traceScope: scope,
      });
      // A heal means the frozen path aged — persist the repair so the NEXT run replays clean.
      // Re-stamp the caseHash: locator/step heals spread the original scenario (hash rides
      // through), but an outcome-heal comes back from discover() without the suite-local field —
      // frozen bare, the next run would mismatch and re-discover a skill that was just repaired
      // (#153). caseHash stays a suite concept; the engine never learns it (pattern ≠ data).
      if (healedScenario) {
        const restamped: FrozenSuiteScenario = { ...healedScenario, caseHash: hashCase(c, ctx.baseUrl) };
        await ctx.store.freeze(ref, restamped);
        scope?.emit({ kind: "freeze", phase: "heal", payload: freezePayload(ref, restamped) });
      }
      const usage = addUsage(discoveryUsage, result.usage ?? emptyUsage());
      scope?.emit({
        kind: "case-end",
        payload: { verdict: result.verdict, usage, discovered, heals: heals.length + stepHeals.length },
      });
      return {
        ...base,
        discovered,
        heals: heals.length + stepHeals.length,
        usage,
        verdict: result.verdict,
      };
    } finally {
      await driver.close().catch(() => {});
    }
  } catch (err) {
    // One crashing case (driver died, discovery threw) must not kill the rest of the suite —
    // fail closed and move on. Aborts DO stop the suite: re-throw them.
    if (ctx.signal?.aborted) throw err;
    const verdict: Verdict = {
      passed: false,
      results: [],
      detail: `case crashed: ${err instanceof Error ? err.message : String(err)}`,
    };
    // A crashed case still ENDED — the trace records it rather than falling silent.
    scope?.emit({
      kind: "case-end",
      payload: { verdict, usage: emptyUsage(), discovered: false, heals: 0 },
    });
    return { ...base, discovered: false, heals: 0, usage: emptyUsage(), verdict };
  }
}
