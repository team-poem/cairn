#!/usr/bin/env node
/**
 * cairn CLI (v0).
 *
 *   cairn run --dogfood                       built-in example.com → first link → network
 *   cairn run --scenario s.json [--json out]  run a scenario file (deterministic)
 *   cairn replay <skill.json> [--json out]    replay a frozen skill (deterministic, no LLM)
 *   cairn discover "<intent>" --url <u>        LLM discover a scenario [--freeze f] [--model m]
 *
 * Exit code is 1 when the verdict fails, so it works as a CI gate.
 */
import { readFile, writeFile } from "node:fs/promises";
import { runHarness } from "./pipeline.js";
import { discover } from "./discover.js";
import { InlineContextProvider } from "./context/inline.js";
import { StaticPlanner } from "./planners/static.js";
import { AssertionCritic } from "./critics/assertion.js";
import { ConsoleReporter } from "./reporters/console.js";
import { JsonReporter } from "./reporters/json.js";
import { ChromeDevToolsDriver } from "./drivers/chrome.js";
import { loadSkillFile } from "./skills/file-store.js";
import { createLlmClient } from "./llm/factory.js";
import type { Reporter, Result, Scenario } from "./index.js";

/** Reproduces the manual MCP verification: example.com → "Learn more" → observe network. */
const DOGFOOD: Scenario = {
  name: "example.com → first link → network",
  steps: [
    { kind: "goto", url: "https://example.com" },
    { kind: "click", target: { text: "Learn more" } },
  ],
  assertions: [{ kind: "navigated" }, { kind: "no-failed-requests" }],
};

function parseArgs(argv: string[]): { positionals: string[]; flags: Map<string, string | boolean> } {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
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

function reporterFor(flags: Map<string, string | boolean>): Reporter {
  const reporters: Reporter[] = [new ConsoleReporter()];
  const jsonOut = flags.get("json");
  if (typeof jsonOut === "string") reporters.push(new JsonReporter(jsonOut));
  return { emit: async (r) => void (await Promise.all(reporters.map((rep) => rep.emit(r)))) };
}

/** Deterministic replay of a fixed scenario — no LLM (invariant #4). */
async function runScenario(scenario: Scenario, flags: Map<string, string | boolean>): Promise<Result> {
  return runHarness(
    {
      context: new InlineContextProvider(),
      planner: new StaticPlanner(scenario),
      driver: new ChromeDevToolsDriver(),
      critic: new AssertionCritic(),
      reporter: reporterFor(flags),
    },
    scenario.name,
  );
}

async function cmdRun(flags: Map<string, string | boolean>): Promise<number> {
  let scenario: Scenario;
  if (flags.get("dogfood")) {
    scenario = DOGFOOD;
  } else {
    const path = flags.get("scenario");
    if (typeof path !== "string") throw new Error("provide --scenario <file.json> or --dogfood");
    scenario = JSON.parse(await readFile(path, "utf8")) as Scenario;
  }
  const result = await runScenario(scenario, flags);
  return result.verdict.passed ? 0 : 1;
}

async function cmdReplay(positionals: string[], flags: Map<string, string | boolean>): Promise<number> {
  const file = positionals[0];
  if (!file) throw new Error("usage: cairn replay <skill.json> [--json out]");
  const skill = await loadSkillFile(file);
  console.log(`replaying frozen skill "${skill.name}" — deterministic, no LLM`);
  const result = await runScenario(skill.scenario, flags);
  return result.verdict.passed ? 0 : 1;
}

async function cmdDiscover(positionals: string[], flags: Map<string, string | boolean>): Promise<number> {
  const intent = positionals[0];
  if (!intent) throw new Error('usage: cairn discover "<intent>" --url <u> [--freeze f] [--model m]');
  const url = typeof flags.get("url") === "string" ? (flags.get("url") as string) : undefined;
  const model = typeof flags.get("model") === "string" ? (flags.get("model") as string) : undefined;

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

  const freeze = flags.get("freeze");
  if (typeof freeze === "string") {
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
