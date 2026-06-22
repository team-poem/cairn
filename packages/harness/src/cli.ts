#!/usr/bin/env node
/**
 * cairn CLI — a thin consumer of the @cairn/harness library.
 *
 *   cairn run --dogfood                       built-in example.com → first link → network
 *   cairn run --scenario s.json [--json out]  run a scenario file (deterministic)
 *   cairn replay <skill.json> [--json out]    replay a frozen skill (deterministic, no LLM)
 *   cairn replay <skill.json> --heal [--freeze f]   repair broken steps via LLM, re-freeze
 *   cairn discover "<intent>" --url <u>        LLM discover a scenario [--freeze f] [--model m]
 *
 * All orchestration lives in the library (`runScenario` / `discover`). This file only
 * parses args, composes reporters, and maps the verdict to an exit code (1 = fail → CI
 * gate). A desktop app or CI job imports the same library functions instead of this CLI.
 */
import { readFile, writeFile } from "node:fs/promises";
import { runScenario, needsLlmCritic } from "./run.js";
import { discover } from "./core/discover.js";
import { ConsoleReporter } from "./adapters/reporters/console.js";
import { JsonReporter } from "./adapters/reporters/json.js";
import { ChromeDevToolsDriver } from "./adapters/drivers/chrome.js";
import { loadSkillFile } from "./adapters/skills/file-store.js";
import { createLlmClient } from "./adapters/llm/factory.js";
import type { Reporter, Scenario } from "./index.js";

/** Reproduces the manual MCP verification: example.com → "Learn more" → observe network. */
const DOGFOOD: Scenario = {
  name: "example.com → first link → network",
  steps: [
    { kind: "goto", url: "https://example.com" },
    { kind: "click", target: { text: "Learn more" } },
  ],
  assertions: [{ kind: "navigated" }, { kind: "no-failed-requests" }],
};

type Flags = Map<string, string | boolean>;

function parseArgs(argv: string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

const flagStr = (flags: Flags, key: string): string | undefined => {
  const v = flags.get(key);
  return typeof v === "string" ? v : undefined;
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
  });

  if (heals.length) {
    console.log(`\nself-healed ${heals.length} step(s):`);
    for (const h of heals) console.log(`  · "${h.original.text}" → "${h.healedText}"`);
    const freeze = flagStr(flags, "freeze");
    if (freeze && healedScenario) {
      await writeFile(freeze, JSON.stringify({ name: healedScenario.name, scenario: healedScenario }, null, 2), "utf8");
      console.log(`  re-frozen → ${freeze}`);
    }
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
    scenario = JSON.parse(await readFile(path, "utf8")) as Scenario;
  }
  return runScenarioCli(scenario, flags);
}

async function cmdReplay(positionals: string[], flags: Flags): Promise<number> {
  const file = positionals[0];
  if (!file) throw new Error("usage: cairn replay <skill.json> [--heal] [--json out]");
  const skill = await loadSkillFile(file);
  const mode = flags.get("heal") ? "self-heal on" : "deterministic, no LLM";
  console.log(`replaying frozen skill "${skill.name}" — ${mode}`);
  return runScenarioCli(skill.scenario, flags);
}

async function cmdDiscover(positionals: string[], flags: Flags): Promise<number> {
  const intent = positionals[0];
  if (!intent) throw new Error('usage: cairn discover "<intent>" --url <u> [--freeze f] [--model m]');
  const url = flagStr(flags, "url");
  const model = flagStr(flags, "model");

  const driver = new ChromeDevToolsDriver();
  const llm = createLlmClient(model ? { model } : {});
  console.log(`discovering with ${llm.id} …`);

  let scenario: Scenario;
  try {
    scenario = await discover(intent, { driver, llm, baseUrl: url });
  } finally {
    await driver.close();
  }

  console.log(`\ndiscovered scenario "${scenario.name}" — ${scenario.steps.length} steps:`);
  for (const step of scenario.steps) console.log(`  · ${JSON.stringify(step)}`);

  const freeze = flagStr(flags, "freeze");
  if (freeze) {
    await writeFile(freeze, JSON.stringify({ name: scenario.name, scenario }, null, 2), "utf8");
    console.log(`\nfrozen → ${freeze}  (replay with: cairn replay ${freeze})`);
  }
  return 0;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positionals, flags } = parseArgs(rest);

  let code: number;
  switch (cmd) {
    case "run":
      code = await cmdRun(flags);
      break;
    case "replay":
      code = await cmdReplay(positionals, flags);
      break;
    case "discover":
      code = await cmdDiscover(positionals, flags);
      break;
    default:
      console.error("usage: cairn <run|replay|discover> …");
      code = 2;
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
