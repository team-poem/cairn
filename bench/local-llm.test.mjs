import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudget } from "./local/budget.mjs";
import { createClaudeClient, createLlm } from "./local/llm.mjs";

/** A stand-in for the `claude` binary: prints whatever JSON the case needs, on the exit code it needs. */
async function fakeCli(body, { exitCode = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cairn-llm-"));
  const path = join(dir, "fake-claude.mjs");
  // It records what it was given on stdin, so a test can prove the prompt actually reached it.
  await writeFile(path, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nlet input = "";\nprocess.stdin.on("data", (chunk) => { input += chunk; });\nprocess.stdin.on("end", () => {\n  writeFileSync(${JSON.stringify(join(dir, "stdin.txt"))}, input);\n  process.stdout.write(${JSON.stringify(typeof body === "string" ? body : JSON.stringify(body))});\n  process.exit(${exitCode});\n});\n`);
  await chmod(path, 0o755);
  return path;
}
const stdinOf = (command) => readFile(join(command, "..", "stdin.txt"), "utf8");

const config = { source: "llm", backend: "claude-code", model: "sonnet", maxCalls: 5, maxCostUsd: 1 };
const client = (command, budget) => createClaudeClient(config, { budget, command });

test("localLlmRecordsCostAndEveryBilledTokenField", async () => {
  const budget = createBudget(config);
  const command = await fakeCli({
    result: "ok",
    total_cost_usd: 0.0125,
    subtype: "success",
    modelUsage: {
      "claude-sonnet": { inputTokens: 11, outputTokens: 22, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: 0.0115, costBasis: "list" },
      "claude-haiku-helper": { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: 0.001, costBasis: "list" },
    },
    usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 },
  });
  const seen = [];
  assert.equal(await client(command, budget).complete("hi", { onUsage: (usage) => seen.push(usage) }), "ok");
  // Cache-creation tokens are billed; dropping them made a token total impossible to reconcile
  // against the reported cost (#214).
  assert.deepEqual(seen, [{ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheCreationTokens: 44 }]);
  const snapshot = budget.snapshot();
  assert.equal(snapshot.calls, 1);
  assert.equal(snapshot.measuredCostUsd, 0.0125);
  assert.equal(snapshot.costComplete, true);
  // One call can bill more than one model, so the ledger keeps the split: a per-model number that
  // silently included the tool's own helper model would not be a number about the model under test.
  assert.deepEqual(snapshot.records, [{
    costUsd: 0.0125,
    error: null,
    modelIds: ["claude-sonnet", "claude-haiku-helper"],
    models: {
      "claude-sonnet": { costUsd: 0.0115, costBasis: "list", inputTokens: 11, outputTokens: 22, cacheReadTokens: 30, cacheCreationTokens: 40 },
      "claude-haiku-helper": { costUsd: 0.001, costBasis: "list", inputTokens: 0, outputTokens: 0, cacheReadTokens: 3, cacheCreationTokens: 4 },
    },
    providerSubtype: "success",
  }]);
});

test("localLlmKeepsPartialUsageAndSurvivesAMissingField", async () => {
  const budget = createBudget(config);
  const command = await fakeCli({ result: "ok", total_cost_usd: 0.01, usage: { input_tokens: 7 } });
  const seen = [];
  await client(command, budget).complete("hi", { onUsage: (usage) => seen.push(usage) });
  assert.deepEqual(seen, [{ inputTokens: 7 }]);
});

test("localLlmRecordsAnUnknownCostSoTheBudgetStopsClosed", async () => {
  const budget = createBudget(config);
  const command = await fakeCli({ result: "ok" }); // no total_cost_usd
  assert.equal(await client(command, budget).complete("hi"), "ok");
  const snapshot = budget.snapshot();
  assert.equal(snapshot.costComplete, false);
  assert.equal(snapshot.stopReason, "LLM cost is unknown");
  assert.deepEqual(snapshot.records, [{ costUsd: null, error: null, modelIds: [] }]); // an absent subtype is omitted, not null
  await assert.rejects(client(command, budget).complete("hi"), /LLM cost is unknown/);
  assert.equal(budget.snapshot().calls, 1); // the refused call never ran
});

test("localLlmChargesForAReportedFailureAndStillThrows", async () => {
  const budget = createBudget(config);
  const command = await fakeCli({ result: "over budget", is_error: true, total_cost_usd: 0.02 });
  await assert.rejects(client(command, budget).complete("hi"), /Claude completion failed: over budget/);
  const snapshot = budget.snapshot();
  assert.equal(snapshot.measuredCostUsd, 0.02); // work that was billed is not lost
  assert.equal(snapshot.records[0].error, "over budget");
});

test("localLlmTreatsUnparsableOutputAsAnUnknownCost", async () => {
  const budget = createBudget(config);
  const command = await fakeCli("not json at all");
  await assert.rejects(client(command, budget).complete("hi"), /no valid JSON/);
  assert.equal(budget.snapshot().costComplete, false);
  assert.equal(budget.snapshot().calls, 1);
});

test("localLlmPassesTheRemainingBudgetToTheProviderAsAHardCap", async () => {
  const budget = createBudget({ ...config, maxCostUsd: 0.5 });
  const dir = await mkdtemp(join(tmpdir(), "cairn-llm-"));
  const argvPath = join(dir, "argv.json");
  const path = join(dir, "fake-claude.mjs");
  await writeFile(path, `#!/usr/bin/env node\nimport { writeFileSync, appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdout.write(JSON.stringify({ result: "ok", total_cost_usd: 0.2 }));\n`);
  await chmod(path, 0o755);
  const paid = createClaudeClient({ ...config, maxCostUsd: 0.5 }, { budget, command: path });
  await paid.complete("first", { system: "SYS" });
  await paid.complete("second");
  const calls = (await readFile(argvPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  // The bench threshold stops after the fact; --max-budget-usd is the only hard cap, and it must
  // shrink by what has already been spent.
  assert.equal(calls[0][calls[0].indexOf("--max-budget-usd") + 1], "0.5");
  assert.equal(calls[1][calls[1].indexOf("--max-budget-usd") + 1], "0.3");
  for (const call of calls) {
    assert.equal(call[call.indexOf("--model") + 1], "sonnet");
    assert.deepEqual(call.slice(call.indexOf("--tools"), call.indexOf("--tools") + 2), ["--tools", ""]);
    assert.ok(call.includes("--no-session-persistence") && call.includes("--safe-mode"));
  }
  assert.deepEqual(calls[0].slice(calls[0].indexOf("--system-prompt")), ["--system-prompt", "SYS"]);
  assert.ok(!calls[1].includes("--system-prompt"));
});

test("localLlmRejectsAnyBackendButTheExplicitPaidOne", () => {
  assert.throws(() => createLlm({ source: "llm", backend: "openai", model: "x", maxCalls: 1, maxCostUsd: 1 }, {}), /claude-code/);
  assert.equal(createLlm({ source: "scripted", label: "offline smoke" }, { tier: "navigation", version: "v1", origin: "http://127.0.0.1:1" }).id, "scripted:offline smoke");
});

test("localLlmSendsThePromptItPaysFor", async () => {
  const budget = createBudget(config);
  const command = await fakeCli({ result: "ok", total_cost_usd: 0.01 });
  assert.equal(await client(command, budget).complete("find the checkout button", { system: "You are a QA agent" }), "ok");
  assert.equal(await stdinOf(command), "find the checkout button");
});

test("localScriptedClientRefusesToSimulateARepair", async () => {
  const scripted = createLlm({ source: "scripted", label: "offline smoke" }, { tier: "navigation", version: "v1", origin: "http://127.0.0.1:9000" });
  assert.equal(scripted.id, "scripted:offline smoke");
  const decide = "You are a QA agent driving a web browser";
  assert.equal(JSON.parse(await scripted.complete("x", { system: decide })).action, "click");
  assert.equal(JSON.parse(await scripted.complete("x", { system: decide })).action, "waitFor");
  assert.deepEqual(JSON.parse(await scripted.complete("x", { system: "You propose verification assertions" })), [{ kind: "navigated", to: "http://127.0.0.1:9000/done" }]);
  // The offline source cannot stand in for a repair decision, which is why a scripted cost run
  // must not be read as a comparison.
  await assert.rejects(scripted.complete("x", { system: "You repair a broken step" }), /does not simulate LLM repair/);
  assert.equal(JSON.parse(await scripted.complete("x", { system: decide })).action, "done");
  await assert.rejects(scripted.complete("x", { system: decide }), /exhausted/);
});

test("localLlmKeepsAnUnpricedModelVisible", async () => {
  const budget = createBudget(config);
  // A model the provider priced on some other basis, or did not price at all, must not silently
  // read as free: the record keeps the basis so a report can say the total is not list price.
  const command = await fakeCli({ result: "ok", total_cost_usd: 0.02, modelUsage: { "claude-sonnet": { inputTokens: 5, costUSD: 0.02, costBasis: "list" }, "some-model": { inputTokens: 9 } } });
  await client(command, budget).complete("hi");
  const [record] = budget.snapshot().records;
  assert.equal(record.models["claude-sonnet"].costBasis, "list");
  assert.deepEqual(record.models["some-model"], { costUsd: null, costBasis: null, inputTokens: 9 });
});
