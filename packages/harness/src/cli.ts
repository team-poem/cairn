#!/usr/bin/env node
/**
 * cairn CLI — a thin consumer of the cairn-engine library.
 *
 *   cairn run --dogfood                       built-in example.com → first link → network
 *   cairn run --scenario s.json [--json out]  run a scenario file (deterministic)
 *   cairn replay <skill.json> [--json out] [--expect-timeout ms]   replay a frozen skill (deterministic, no LLM)
 *   cairn replay <skill.json> --heal [--freeze f]   repair broken steps via LLM, re-freeze
 *   cairn discover "<intent>" --url <u>        LLM discover a scenario [--freeze f] [--model m] [--max-steps n]
 *   cairn explore "<charter>" --url <u>        LLM survey the app for UX problems (freeze-less, #102)
 *                                              [--model m] [--max-steps n] [--report out.md] [--json out.json]
 *   cairn suite <cases.json>                   run a case list: replay cached skills, discover+freeze misses
 *                                              [--skills dir] [--base-url u] [--no-heal] [--model m]
 *                                              [--report out.md] [--json out.json]
 *
 * All orchestration lives in the library (`runScenario` / `discover` / `explore` / `runSuite`). This file
 * only parses args, composes reporters, and maps the verdict to an exit code (1 = fail → CI
 * gate). A desktop app or CI job imports the same library functions instead of this CLI.
 */
import { readFile, writeFile } from "node:fs/promises";
import { runScenario, needsLlmCritic } from "./run.js";
import { discover } from "./core/discover/index.js";
import { explore } from "./core/explore/index.js";
import type { ExploreReport } from "./core/explore/index.js";
import { describeAction } from "./core/discover/decision.js";
import { renderExploreReport } from "./adapters/reporters/markdown.js";
import { runSuite } from "./suite.js";
import type { SuiteCase, SuiteResult } from "./suite.js";
import { renderSuiteReport, unprovenLabel } from "./adapters/reporters/suite.js";
import {
  droppedProofReason,
  guessedKeyRuns,
  hasSemanticCriterion,
  provesAnAction,
  weakTargets,
} from "./core/freeze.js";
import { Tracer } from "./core/trace.js";
import { ConsoleReporter } from "./adapters/reporters/console.js";
import { JsonReporter } from "./adapters/reporters/json.js";
import { ChromeDevToolsDriver } from "./adapters/drivers/chrome.js";
import { FileSkillStore } from "./adapters/skills/file-store.js";
import { createLlmClient } from "./adapters/llm/factory.js";
import { flagNum, flagStr, parseArgs } from "./cli-args.js";
import { ENGINE_VERSION } from "./version.js";
import type { Reporter, Scenario } from "./index.js";
import type { Flags } from "./cli-args.js";

/** One SkillStore for every CLI load/freeze — refs are paths relative to the cwd. */
const skills = new FileSkillStore();

/** Reproduces the manual MCP verification: example.com → "Learn more" → observe network. */
const DOGFOOD: Scenario = {
  name: "example.com → first link → network",
  steps: [
    { kind: "goto", url: "https://example.com" },
    { kind: "click", target: { text: "Learn more" } },
  ],
  assertions: [{ kind: "navigated" }, { kind: "no-failed-requests" }],
};

function reporterFor(flags: Flags): Reporter {
  const reporters: Reporter[] = [new ConsoleReporter()];
  const jsonOut = flagStr(flags, "json");
  if (jsonOut) reporters.push(new JsonReporter(jsonOut));
  return { emit: async (r) => void (await Promise.all(reporters.map((rep) => rep.emit(r)))) };
}

/** Run a scenario through the library and surface CLI-specific output (heal log, freeze). */
async function runScenarioCli(scenario: Scenario, flags: Flags): Promise<number> {
  if (needsLlmCritic(scenario)) console.log("scenario has 'expect' criteria → judging with LlmCritic");

  const { result, heals, healedScenario } = await runScenario(scenario, {
    reporter: reporterFor(flags),
    model: flagStr(flags, "model"),
    heal: Boolean(flags.get("heal")),
    // --expect-timeout: how long a step's `expect` is polled before it counts as diverged —
    // a slow app (3-5s list loads) needs more than the 2s default (#95).
    expectTimeoutMs: flagNum(flags, "expect-timeout"),
  });

  if (heals.length) {
    console.log(`\nself-healed ${heals.length} step(s):`);
    for (const h of heals) console.log(`  · "${h.original.text}" → "${h.healed.text ?? h.healed.selector}"`);
  } else if (healedScenario) {
    // outcome-heal: the run failed its assertions, so the whole scenario was re-discovered.
    console.log(`\nrun failed its assertions → re-discovered the scenario (${healedScenario.steps.length} step(s))`);
  }
  const freeze = flagStr(flags, "freeze");
  if (freeze && healedScenario) {
    await skills.freeze(freeze, healedScenario);
    console.log(`  re-frozen → ${freeze}`);
  }
  return result.verdict.passed ? 0 : 1;
}

async function cmdRun(flags: Flags): Promise<number> {
  let scenario: Scenario;
  if (flags.get("dogfood")) {
    scenario = DOGFOOD;
  } else {
    const path = flagStr(flags, "scenario");
    if (!path) throw new Error("provide --scenario <file.json> or --dogfood");
    // Validate the shape (name/steps/assertions) instead of a blind cast — a malformed file fails
    // here with a clear error rather than deep in the run.
    scenario = await skills.load(path);
  }
  return runScenarioCli(scenario, flags);
}

async function cmdReplay(positionals: string[], flags: Flags): Promise<number> {
  const file = positionals[0];
  if (!file) throw new Error("usage: cairn replay <skill.json> [--heal] [--json out] [--expect-timeout ms]");
  const scenario = await skills.load(file);
  const mode = flags.get("heal") ? "self-heal on" : "deterministic, no LLM";
  console.log(`replaying frozen skill "${scenario.name}" — ${mode}`);
  return runScenarioCli(scenario, flags);
}

async function cmdDiscover(positionals: string[], flags: Flags): Promise<number> {
  const intent = positionals[0];
  if (!intent) {
    throw new Error(
      'usage: cairn discover "<intent>" --url <u> [--freeze f] [--model m] [--max-steps n] [--semantic]',
    );
  }
  const url = flagStr(flags, "url");
  const model = flagStr(flags, "model");

  const driver = new ChromeDevToolsDriver();
  const llm = createLlmClient(model ? { model } : {});
  console.log(`discovering with ${llm.id} …`);

  // A grounding drop only rides the trace, so a CLI user never learns why the freeze ended up
  // without a proof that the action fired — and that is not fail-closed on its own: a surviving
  // `navigated` still passes the scenario. Collect the reasons through the shipped sink seam; what
  // decides the warning is the frozen result, not these.
  const droppedProofs: string[] = [];
  const trace = new Tracer({
    emit: (event) => {
      const reason = droppedProofReason(event);
      if (reason) droppedProofs.push(reason);
    },
  }).scope("discover");

  let scenario: Scenario;
  try {
    // #16: --semantic lets the freeze carry LLM-judged `expect` checks (replay then needs an LlmCritic).
    // --max-steps: step cap for the loop — a realistic form flow can need more than the default (#95).
    scenario = await discover(intent, {
      driver,
      llm,
      baseUrl: url,
      maxSteps: flagNum(flags, "max-steps"),
      semanticChecks: Boolean(flags.get("semantic")),
      trace,
    });
  } finally {
    await driver.close();
  }

  console.log(`\ndiscovered scenario "${scenario.name}" — ${scenario.steps.length} steps:`);
  for (const step of scenario.steps) console.log(`  · ${JSON.stringify(step)}`);

  if (scenario.truncated) {
    console.log(`\n⚠ stopped at the step cap without reaching "done" — the path may be incomplete.`);
  }

  // #14: flag weak (text-only) targets at freeze time, before a UI rename forces a self-heal.
  const weak = weakTargets(scenario);
  if (weak.length) {
    console.log(`\n⚠ ${weak.length} weak target(s) — a UI rename may force a self-heal; strengthen up front:`);
    for (const w of weak) console.log(`  · step ${w.stepIndex + 1} (${w.step.kind}): ${w.score.reason}`);
  }

  // #61: flag blind key-press chains — a guessed step can act on the wrong element yet pass.
  for (const run of guessedKeyRuns(scenario)) {
    console.log(
      `\n⚠ steps ${run.startIndex + 1}–${run.startIndex + run.keys.length} press keys blindly (${run.keys.join(", ")}) — ` +
        `discover guessed instead of resolving a target; review before trusting.`,
    );
  }

  // #137: flag checks the starting state already satisfied — they cannot catch a broken flow.
  if (scenario.assertions.length > 0 && scenario.assertions.every((a) => a.vacuous)) {
    console.log(
      `\n⚠ every assertion was already true before the flow ran — replay will FAIL closed. ` +
        `Re-discover, or add a check that only the flow can satisfy.`,
    );
  } else {
    for (const a of scenario.assertions) {
      if (a.vacuous && (a.kind === "navigated" || a.kind === "request-status")) {
        console.log(`\n⚠ ${JSON.stringify(a)} — already true at the start; this check cannot detect a broken flow.`);
      }
    }
  }

  // Warn on what the freeze CARRIES: a scenario with a live request check proves its action even if
  // another proposal was dropped along the way, and one with none needs saying so even if nothing
  // was proposed to drop. A read-only flow has no action to prove and is warned about anyway.
  if (!provesAnAction(scenario)) {
    console.log(
      hasSemanticCriterion(scenario)
        ? `\n⚠ nothing mechanical here checks that the action fired — only the semantic criterion, ` +
            `which an LLM judges at replay and which this freeze never grounded against the run.`
        : `\n⚠ nothing here checks that the action itself fired — replay passes as soon as the page ` +
            `is reached. Fine for a read-only flow; otherwise re-discover, or add a check of your own.`,
    );
    // One line per distinct reason: the same refusal repeats once per proposal, and a wall of
    // identical lines reads as many problems instead of one.
    for (const reason of [...new Set(droppedProofs)]) console.log(`  · proposed check dropped: ${reason}`);
  }
  // #184: the flow DID fire a state change, and no check could be written for it — so this is not a
  // read-only flow, and the warning above is not fine to wave through.
  if (scenario.unprovenAction) {
    console.log(
      `\n⚠ the flow fired ${scenario.unprovenAction} and no check can express it (its URL has no ` +
        `stable path) — replay cannot tell whether that action happened. Mark the endpoint benign if ` +
        `it is background traffic; otherwise add a check of your own.`,
    );
  }

  const freeze = flagStr(flags, "freeze");
  if (freeze) {
    await skills.freeze(freeze, scenario);
    console.log(`\nfrozen → ${freeze}  (replay with: cairn replay ${freeze})`);
  }
  return 0;
}

async function cmdExplore(positionals: string[], flags: Flags): Promise<number> {
  const charter = positionals[0];
  const url = flagStr(flags, "url");
  if (!charter || !url) {
    throw new Error(
      'usage: cairn explore "<charter>" --url <u> [--model m] [--max-steps n] [--report out.md] [--json out.json]',
    );
  }
  const model = flagStr(flags, "model");

  const driver = new ChromeDevToolsDriver();
  const llm = createLlmClient(model ? { model } : {});
  console.log(`exploring with ${llm.id} …`);

  let report: ExploreReport;
  try {
    report = await explore(charter, {
      driver,
      llm,
      baseUrl: url,
      maxSteps: flagNum(flags, "max-steps"),
      onStep: (decision) => console.log(`  · ${describeAction(decision)}`),
      onFinding: (f) => console.log(`  ⚑ [${f.severity}] ${f.detail}`),
    });
  } finally {
    await driver.close();
  }

  const markdown = renderExploreReport(report);
  const reportPath = flagStr(flags, "report");
  if (reportPath) {
    await writeFile(reportPath, markdown, "utf8");
    console.log(`\nreport → ${reportPath}`);
  } else {
    console.log(`\n${markdown}`);
  }
  const jsonPath = flagStr(flags, "json");
  if (jsonPath) {
    await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`json → ${jsonPath}`);
  }

  if (report.truncated) {
    console.log(`⚠ stopped at the step cap before the charter was covered — coverage is partial.`);
  }
  // CI gate: error-severity findings (real failures a user would hit) fail the run; warns/infos don't.
  return report.findings.some((f) => f.severity === "error") ? 1 : 0;
}

/** A cases file is either a bare `SuiteCase[]` or `{ baseUrl?, cases: SuiteCase[] }`. */
async function loadCasesFile(path: string): Promise<{ cases: SuiteCase[]; baseUrl?: string }> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (Array.isArray(parsed)) return { cases: parsed as SuiteCase[] };
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { cases?: unknown }).cases)) {
    const obj = parsed as { cases: SuiteCase[]; baseUrl?: string };
    return { cases: obj.cases, baseUrl: obj.baseUrl };
  }
  throw new Error(`${path}: expected a case array or { baseUrl?, cases: [...] }`);
}

async function cmdSuite(positionals: string[], flags: Flags): Promise<number> {
  const file = positionals[0];
  if (!file) {
    throw new Error(
      "usage: cairn suite <cases.json> [--skills dir] [--base-url u] [--no-heal] [--model m] [--report out.md] [--json out.json]",
    );
  }
  const { cases, baseUrl } = await loadCasesFile(file);
  console.log(`suite: ${cases.length} case(s)`);

  const suite: SuiteResult = await runSuite(cases, {
    skillDir: flagStr(flags, "skills"),
    baseUrl: flagStr(flags, "base-url") ?? baseUrl,
    heal: !flags.get("no-heal"),
    model: flagStr(flags, "model"),
    expectTimeoutMs: flagNum(flags, "expect-timeout"),
    onCase: (v) =>
      console.log(
        `  ${v.verdict.passed ? "✓" : "✗"} ${v.id} — ${v.truncated ? "discovery truncated" : v.discovered ? "discovered + replayed" : "replayed"}` +
          `${v.heals ? ` · ${v.heals} heal(s)` : ""} · llm ${v.usage.llmCalls} call(s)${unprovenLabel(v)}`,
      ),
  });

  const markdown = renderSuiteReport(suite);
  const reportPath = flagStr(flags, "report");
  if (reportPath) {
    await writeFile(reportPath, markdown, "utf8");
    console.log(`\nreport → ${reportPath}`);
  } else {
    console.log(`\n${markdown}`);
  }
  const jsonPath = flagStr(flags, "json");
  if (jsonPath) {
    await writeFile(jsonPath, JSON.stringify(suite, null, 2), "utf8");
    console.log(`json → ${jsonPath}`);
  }
  return suite.passed ? 0 : 1;
}

const HELP = `cairn ${ENGINE_VERSION} — agentic-testing engine CLI

usage: cairn <command> [options]

  run --dogfood | --scenario <file.json> [--json out]
  replay <skill.json> [--heal] [--freeze f] [--json out] [--expect-timeout ms]
  discover "<intent>" --url <u> [--freeze f] [--model m] [--max-steps n] [--semantic]
  explore "<charter>" --url <u> [--model m] [--max-steps n] [--report out.md] [--json out.json]
  suite <cases.json> [--skills dir] [--base-url u] [--no-heal] [--model m] [--report out.md] [--json out.json]

  --help, -h       print this message
  --version, -v    print the engine version

discover once with an LLM → freeze to plain JSON → replay forever with zero LLM calls → heal only when it breaks.
Docs: https://github.com/team-poem/cairn`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positionals, flags } = parseArgs(rest);

  let code: number;
  switch (cmd) {
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      code = 0;
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(ENGINE_VERSION);
      code = 0;
      break;
    case "run":
      code = await cmdRun(flags);
      break;
    case "replay":
      code = await cmdReplay(positionals, flags);
      break;
    case "discover":
      code = await cmdDiscover(positionals, flags);
      break;
    case "explore":
      code = await cmdExplore(positionals, flags);
      break;
    case "suite":
      code = await cmdSuite(positionals, flags);
      break;
    default:
      console.error("usage: cairn <run|replay|discover|explore|suite> … (cairn --help for details)");
      code = 2;
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
