import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBudget } from "./local/budget.mjs";
import { createLlm } from "./local/llm.mjs";
import { validateConfig, validateCostConfig } from "./local/config.mjs";

const config = { source: "llm", backend: "codex", model: "explicit-model", budgetMode: "calls", maxCalls: 5 };
// Event shape captured from Codex CLI 0.146.0; input includes cached input and output includes reasoning.
const events = (usage = { input_tokens: 100, cached_input_tokens: 30, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 10 }) => [
  { type: "thread.started", thread_id: "test" }, { type: "turn.started" },
  { type: "item.completed", item: { type: "agent_message", text: "answer" } },
  { type: "turn.completed", usage },
];
async function fakeCodex(t, output = events(), { exitCode = 0, hang = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cairn-fake-codex-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const command = join(dir, "codex.mjs");
  await writeFile(command, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nlet input = "";\nprocess.stdin.on("data", chunk => input += chunk);\nprocess.stdin.on("end", () => {\nwriteFileSync(${JSON.stringify(join(dir, "invocation.json"))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input }));\nprocess.stdout.write(${JSON.stringify(typeof output === "string" ? output : output.map(event => JSON.stringify(event)).join("\n") + "\n")});\n${hang ? "setInterval(() => {}, 1000);" : `process.exit(${exitCode});`}\n});\n`);
  await chmod(command, 0o755);
  return { command, invocation: () => readFile(join(dir, "invocation.json"), "utf8").then(JSON.parse) };
}

test("codexReportsTokensWithoutInventingMoneyOrDoubleCountingCache", async (t) => {
  const fake = await fakeCodex(t);
  const budget = createBudget(config);
  const usage = [];
  const client = createLlm(config, { budget, command: fake.command });
  assert.equal(await client.complete("prompt", { system: "system", onUsage: value => usage.push(value) }), "answer");
  assert.deepEqual(usage, [{ inputTokens: 70, cacheReadTokens: 30, cacheCreationTokens: 0, outputTokens: 20 }]);
  assert.equal(budget.snapshot().costComplete, false);
  assert.equal(budget.snapshot().records[0].costUsd, null);
  assert.equal(budget.snapshot().records[0].models, undefined);
  assert.equal(budget.snapshot().stopReason, null);
  await client.complete("second");
  assert.equal(budget.snapshot().calls, 2);
  const invocation = await fake.invocation();
  assert.match(invocation.input, /prompt|second/);
  assert.notEqual(invocation.cwd, process.cwd());
  await assert.rejects(readFile(join(invocation.cwd, "anything")), /ENOENT/);
  for (const value of ["exec", "--json", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "read-only", "features.shell_tool=false", 'web_search="disabled"', "project_doc_max_bytes=0", "explicit-model"]) assert.ok(invocation.args.includes(value), value);
});

test("codexPreservesPartialUsageAndRejectsIncompleteOrFailedTurns", async (t) => {
  for (const output of [events({ input_tokens: 10 }), events().slice(0, -1), [events()[3]], "not json", [...events(), { type: "turn.failed", error: { message: "failed" } }]]) {
    const fake = await fakeCodex(t, output);
    const budget = createBudget(config);
    const usage = [];
    const complete = createLlm(config, { budget, command: fake.command }).complete("x", { onUsage: value => usage.push(value) });
    if (Array.isArray(output) && output[3]?.usage?.input_tokens === 10) {
      assert.equal(await complete, "answer");
      assert.deepEqual(usage, [{}]); // The uncached portion is unknown without a cache count.
    } else await assert.rejects(complete);
    assert.equal(budget.snapshot().calls, 1);
    assert.equal(budget.snapshot().records.length, 1);
    assert.equal(budget.snapshot().costComplete, false);
  }
});

test("codexRetainsUsageOnProcessFailureAndAccountsForCancellation", async (t) => {
  const fake = await fakeCodex(t, events(), { exitCode: 1 });
  const budget = createBudget(config);
  const usage = [];
  await assert.rejects(createLlm(config, { budget, command: fake.command }).complete("x", { onUsage: value => usage.push(value) }));
  assert.equal(usage[0].outputTokens, 20);
  assert.equal(budget.snapshot().records.length, 1);
  const hanging = await fakeCodex(t, [], { hang: true });
  const controller = new AbortController();
  const cancelled = createBudget(config);
  const completion = createLlm(config, { budget: cancelled, command: hanging.command, signal: controller.signal }).complete("x");
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(completion);
  assert.equal(cancelled.snapshot().records.length, 1);
});

test("callBudgetIsExplicitAndNeverImpliesADollarLimit", () => {
  const base = { mode: "discover", tiers: ["navigation"], runs: 2, fixtureVersion: "v1", latency: { document: [0], api: [0] }, engineCommit: "a".repeat(40), outputDir: "/unused", llm: config };
  assert.equal(validateConfig(base), base);
  assert.equal(validateCostConfig({ ...base, mode: "cost", arms: ["agent", "cairn"], fixtureVersions: ["v1", "v1"] }).llm.budgetMode, "calls");
  for (const patch of [{ maxCostUsd: 1 }, { maxCalls: 0 }, { budgetMode: "guess" }]) {
    assert.throws(() => validateConfig({ ...base, llm: { ...config, ...patch } }));
    assert.throws(() => createBudget({ ...config, ...patch }));
  }
  const budget = createBudget({ ...config, maxCalls: 2 });
  budget.reserve();
  assert.throws(() => budget.reserve());
  budget.record({ costUsd: null });
  budget.reserve(); budget.record({ costUsd: null });
  assert.match(budget.snapshot().stopReason, /call limit/);
  assert.throws(() => budget.reserve());
});

test("codexOnlySettingsAreNotSilentlyAcceptedByClaude", () => {
  const base = { mode: "discover", tiers: ["navigation"], runs: 2, fixtureVersion: "v1", latency: { document: [0], api: [0] }, engineCommit: "a".repeat(40), outputDir: "/unused" };
  assert.throws(() => validateConfig({ ...base, llm: { ...config, backend: "claude-code" } }), /codex/);
  assert.throws(() => validateConfig({ ...base, llm: { source: "llm", backend: "claude-code", model: "x", maxCalls: 5, maxCostUsd: 1, reasoningEffort: "medium" } }), /codex/);
});

test("codexPassesTheExplicitReasoningSettingAndSystemPrompt", async (t) => {
  const fake = await fakeCodex(t);
  await createLlm({ ...config, reasoningEffort: "medium" }, { budget: createBudget(config), command: fake.command }).complete("prompt", { system: "system" });
  const invocation = await fake.invocation();
  assert.ok(invocation.args.includes('model_reasoning_effort="medium"'));
  assert.equal(invocation.input, "<system>\nsystem\n</system>\n\nprompt");
});

test("codexDiscoveryReportAlsoLabelsMissingMoneyUnknown", async () => {
  const { renderMarkdown } = await import("./local/report.mjs");
  const markdown = renderMarkdown({ summaries: [], records: [], configuration: { mode: "discover", llm: config }, engine: {}, budget: { measuredCostUsd: 0, costComplete: false } });
  assert.match(markdown, /Reported provider cost: unknown/);
});
test("codexSeparatesCacheWritesAlreadyIncludedInInput", async (t) => {
  const fake = await fakeCodex(t, events({ input_tokens: 1200, cached_input_tokens: 400, cache_write_input_tokens: 500, output_tokens: 200, reasoning_output_tokens: 100 }));
  const usage = [];
  await createLlm(config, { budget: createBudget(config), command: fake.command }).complete("x", { onUsage: value => usage.push(value) });
  assert.deepEqual(usage, [{ inputTokens: 300, cacheReadTokens: 400, cacheCreationTokens: 500, outputTokens: 200 }]);
  assert.equal(Object.values(usage[0]).reduce((sum, n) => sum + n, 0), 1400);
});
test("codexUsesTerminalSuccessAfterARecoverableDiagnostic", async (t) => {
  const output = events();
  output.splice(2, 0, { type: "error", message: "Reconnecting... 2/5 (request timed out)" });
  const fake = await fakeCodex(t, output);
  const budget = createBudget(config);
  assert.equal(await createLlm(config, { budget, command: fake.command }).complete("x"), "answer");
  assert.deepEqual(budget.snapshot().records[0].providerDiagnostics, ["Reconnecting... 2/5 (request timed out)"]);
});

test("codexRejectsReroutedModelsButRetainsTheirReportedUsage", async (t) => {
  const output = events();
  output.splice(2, 0, { type: "item.completed", item: { type: "error", message: "model rerouted: explicit-model -> another-model (HighRiskRequest)" } });
  const fake = await fakeCodex(t, output);
  const budget = createBudget(config);
  const usage = [];
  await assert.rejects(createLlm(config, { budget, command: fake.command }).complete("x", { onUsage: value => usage.push(value) }), /model rerouted/);
  assert.equal(usage[0].outputTokens, 20);
  assert.match(budget.snapshot().records[0].error, /another-model/);
});
