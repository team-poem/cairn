#!/usr/bin/env node
/**
 * cairn CLI (v0). Wires the default deterministic pipeline and runs one scenario.
 *
 *   cairn run --dogfood                 # built-in example.com → first link → network
 *   cairn run --scenario path.json      # run a scenario file
 *   cairn run --scenario p.json --json out.json
 *
 * Exit code is 1 when the verdict fails, so it works as a CI gate.
 */
import { readFile } from "node:fs/promises";
import { runHarness } from "./pipeline.js";
import { InlineContextProvider } from "./context/inline.js";
import { StaticPlanner } from "./planners/static.js";
import { AssertionCritic } from "./critics/assertion.js";
import { ConsoleReporter } from "./reporters/console.js";
import { JsonReporter } from "./reporters/json.js";
import { ChromeDevToolsDriver } from "./drivers/chrome.js";
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

function parseArgs(argv: string[]): Map<string, string | boolean> {
  const args = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      i++;
    } else {
      args.set(key, true);
    }
  }
  return args;
}

async function loadScenario(args: Map<string, string | boolean>): Promise<Scenario> {
  if (args.get("dogfood")) return DOGFOOD;
  const path = args.get("scenario");
  if (typeof path !== "string") {
    throw new Error("provide --scenario <file.json> or --dogfood");
  }
  return JSON.parse(await readFile(path, "utf8")) as Scenario;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "run") {
    console.error("usage: cairn run [--dogfood | --scenario <file.json>] [--json <out>]");
    process.exit(2);
  }

  const args = parseArgs(rest);
  const scenario = await loadScenario(args);

  const reporters: Reporter[] = [new ConsoleReporter()];
  const jsonOut = args.get("json");
  if (typeof jsonOut === "string") reporters.push(new JsonReporter(jsonOut));

  const result = await runHarness(
    {
      context: new InlineContextProvider(),
      planner: new StaticPlanner(scenario),
      driver: new ChromeDevToolsDriver(),
      critic: new AssertionCritic(),
      reporter: { emit: async (r) => void (await Promise.all(reporters.map((rep) => rep.emit(r)))) },
    },
    scenario.name,
  );

  process.exit(result.verdict.passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
