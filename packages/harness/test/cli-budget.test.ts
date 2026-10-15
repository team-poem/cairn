import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { suiteExitCode } from "../src/cli-exit.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const execute = promisify(execFile);
async function run(args: string[]) {
  try { return { ...(await execute(process.execPath, ["--import", "tsx", cli, ...args], { timeout: 10_000 })), code: 0 }; }
  catch (error) { return error as Error & { code: number; stdout: string; stderr: string }; }
}

it.each(["discover", "explore"])("%s reports a typed zero-deadline stop without launching a browser", async command => {
  const result = await run([command, "checkout", "--url", "https://unused.invalid", "--run-timeout", "0"]);
  expect(result.code).toBe(5);
  const error = JSON.parse(result.stderr);
  expect(error).toMatchObject({ error: "BudgetExceededError", budget: { limit: "time", modelCalls: 0 }, usage: { llmCalls: 0 } });
});

it("run writes a budget verdict to JSON and uses exit 5", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cairn-budget-cli-")); dirs.push(dir);
  const json = join(dir, "result.json");
  const result = await run(["run", "--dogfood", "--run-timeout", "0", "--json", json]);
  expect(result.code).toBe(5);
  expect(JSON.parse(await readFile(json, "utf8")).verdict).toMatchObject({ passed: false, failure: "budget" });
});

it("suite exposes independent zero-deadline outcomes in its JSON report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cairn-budget-cli-")); dirs.push(dir);
  const cases = join(dir, "cases.json");
  const json = join(dir, "result.json");
  await writeFile(cases, JSON.stringify(["a", "b"].map(id => ({ id, intent: "checkout", url: "https://unused.invalid" }))));
  const result = await run(["suite", cases, "--run-timeout", "0", "--json", json]);
  expect(result.code).toBe(5);
  expect(JSON.parse(await readFile(json, "utf8")).verdicts.map((v: { verdict: { failure: string } }) => v.verdict.failure)).toEqual(["budget", "budget"]);
});

it("invalid budget flags are usage errors, not failed runs", async () => {
  expect((await run(["run", "--dogfood", "--max-model-calls=-1"])).code).toBe(2);
});

it("suite exit priority keeps genuine failures ahead of budget stops", () => {
  const budget = { passed: false, results: [], failure: "budget" as const };
  expect(suiteExitCode([budget])).toBe(5);
  expect(suiteExitCode([budget, { ...budget, failure: "environment" }])).toBe(5);
  expect(suiteExitCode([budget, { ...budget, failure: "script" }])).toBe(3);
  expect(suiteExitCode([budget, { ...budget, failure: "flow" }])).toBe(1);
});
