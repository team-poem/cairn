// Evidence for #230: distill raw bench output into a reviewable JSON, and render its tables back.
//
//   node docs/benchmarks/230-evidence.mjs distill OUT.json LABEL=DIR [LABEL=DIR ...]
//   node docs/benchmarks/230-evidence.mjs table IN.json
//
// `distill` reads each DIR's results.json (a cost comparison or a replay report), its captures and
// sidecars, and keeps the fields a reader needs to check the claims: engine identity, runtime,
// configuration, per-run outcomes, usage, cost, and every scenario hash. Absolute paths, stack
// traces and the provider ledger are dropped. The SHA-256 of every source file is kept, so the
// distilled file can be checked against the ignored originals. `table` prints Markdown from the
// distilled file and nothing else, so a published table is regenerable from the data it cites.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pick = (object, keys) => Object.fromEntries(keys.filter((key) => key in object).map((key) => [key, object[key]]));
const error = (value) => (value ? pick(value, ["name", "message"]) : null);

async function distillOne(label, directory) {
  const bytes = await readFile(join(directory, "results.json"));
  const report = JSON.parse(bytes);
  const sources = { "results.json": sha256(bytes) };
  for (const name of ["results.md", "cost-stateful.svg"]) {
    try { sources[name] = sha256(await readFile(join(directory, name))); } catch (cause) { if (cause.code !== "ENOENT") throw cause; }
  }
  const captures = [];
  const scan = async (dir, prefix) => {
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (cause) { if (cause.code === "ENOENT") return; throw cause; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { await scan(path, `${prefix}${entry.name}/`); continue; }
      if (!entry.name.endsWith(".skill.json")) continue;
      const scenario = await readFile(path);
      const meta = JSON.parse(await readFile(`${path}.meta.json`, "utf8"));
      if (meta.scenarioHash !== sha256(scenario)) throw new Error(`Capture hash mismatch: ${path}`);
      const parsed = JSON.parse(scenario);
      captures.push({ name: `${prefix}${entry.name}`, scenarioHash: meta.scenarioHash, ...pick(meta, ["tier", "fixtureVersion", "fixtureHash", "captureOrigin", "source"]), assertions: parsed.assertions, steps: parsed.steps.map((step) => pick(step, ["kind", "url", "target", "text", "until", "expect"])) });
    }
  };
  await scan(join(directory, "captures"), "");
  const cost = report.kind === "cost-comparison";
  const { signal: _signal, outputDir: _out, captureDir, ...configuration } = report.configuration;
  const records = report.records.map((record) => ({
    ...pick(record, cost
      ? ["tier", "arm", "index", "fixtureVersion", "action", "completed", "passed", "verdict", "oracle", "healCount", "refrozen", "usageComplete", "models", "scenarioHash", "replayedScenarioHash", "fixtureHash", "requestedDelays", "engineUsage", "observedUsage", "costUsd", "measuredCostUsd", "elapsedMs"]
      : ["tier", "mode", "index", "completed", "passed", "journey", "verdict", "proof", "failure", "oracle", "usage", "engineUsage", "observedUsage", "healCount", "scenarioHash", "fixtureHash", "captureFixtureVersion", "captureFixtureHash", "captureSource", "requestedDelays", "costUsd", "elapsedMs"]),
    error: error(record.error),
    ...(record.engineVerdict ? { engineVerdict: pick(record.engineVerdict, ["passed", "detail", "failure", "proof"]) } : {}),
    ...(record.cleanupErrors ? { cleanupErrors: record.cleanupErrors.map(error) } : {}),
  }));
  return {
    label, kind: cost ? "cost-comparison" : "reliability", directory: basename(directory), sources,
    ...(captureDir ? { captureDir: basename(captureDir) } : {}),
    ...pick(report, ["engine", "runtime", "configHash", "startedAt", "finishedAt", "requested", "attempted", "incomplete", "stopReason"]),
    configuration,
    budget: report.budget ? pick(report.budget, ["calls", "measuredCostUsd", "costComplete", "stopReason"]) : null,
    summaries: report.summaries, records, captures,
  };
}

const money = (value) => (value === null || value === undefined ? "unknown" : `$${value.toFixed(6)}`);

function renderCost(m) {
  const lines = [];
  for (const summary of m.summaries) {
    for (const [arm, entry] of Object.entries(summary.arms)) {
      const p = entry.phases;
      lines.push(`| ${m.configuration.llm.model} | ${arm} | ${p.discovery.runs} · ${p.discovery.calls} calls · ${money(p.discovery.costUsd)} | ${p.repair.runs} attempted · ${p.repair.refrozen} re-frozen · ${p.repair.calls} calls · ${money(p.repair.costUsd)} | ${p.replay.passed}/${p.replay.runs} | ${entry.attempted - entry.failures}/${entry.attempted} |`);
    }
  }
  const runs = m.records.map((r) => `| ${m.configuration.llm.model} | ${r.arm} | ${r.index + 1} | ${r.fixtureVersion} | ${r.action} | ${r.observedUsage.llmCalls} | ${money(r.costUsd)} | ${r.passed ? "pass" : "FAIL"} | ${r.refrozen ? "yes" : ""} | ${(r.replayedScenarioHash ?? "").slice(0, 12)} | ${(r.scenarioHash ?? "").slice(0, 12)} |`);
  return { phases: lines, runs };
}

async function main() {
  const [command, first, ...rest] = process.argv.slice(2);
  if (command === "distill") {
    if (!first || !rest.length) throw new Error("usage: distill OUT.json LABEL=DIR ...");
    const measurements = [];
    for (const pair of rest) {
      const at = pair.indexOf("=");
      if (at < 1) throw new Error(`Expected LABEL=DIR, got ${pair}`);
      measurements.push(await distillOne(pair.slice(0, at), pair.slice(at + 1)));
    }
    const out = { description: "Generated subset of raw bench/results reports for #230. Absolute paths, stack traces and provider ledger entries are omitted; every kept field has its reported value. `sources` holds the SHA-256 of each original file. A cost run's records carry the hash of the scenario they replayed and the hash of the scenario they saved, so a run after a repair can be matched to the repair it used.", generatedBy: "docs/benchmarks/230-evidence.mjs distill", measurements };
    await writeFile(first, JSON.stringify(out, null, 2) + "\n");
    console.log(`wrote ${first}: ${measurements.map((m) => `${m.label} (${m.kind}, ${m.records.length} records, ${m.captures.length} captures)`).join("; ")}`);
    return;
  }
  if (command === "table") {
    const { measurements } = JSON.parse(await readFile(first, "utf8"));
    const phases = [], runs = [], replays = [];
    for (const m of measurements) {
      if (m.kind === "cost-comparison") { const t = renderCost(m); phases.push(...t.phases.map((l) => l.replace("| ", `| ${m.label} | `))); runs.push(...t.runs.map((l) => l.replace("| ", `| ${m.label} | `))); continue; }
      for (const r of m.records) replays.push(`| ${m.label} | ${m.configuration.fixtureVersion} | ${r.index + 1} | ${(r.scenarioHash ?? "").slice(0, 12)} | ${r.usage?.llmCalls ?? "unknown"} / ${r.observedUsage?.llmCalls ?? "unknown"} | ${r.verdict === null ? "none" : r.verdict ? "pass" : "fail"} | ${r.oracle?.complete ? "complete" : "incomplete"} | ${r.passed ? "pass" : "FAIL"} | ${(r.error?.message ?? r.engineVerdict?.detail ?? "").slice(0, 120)} |`);
    }
    console.log(["| Run | Model | Arm | Discovery (runs · calls · cost) | Repair (attempted · re-frozen · calls · cost) | Replays without a call | Passed |", "| --- | --- | --- | --- | --- | ---: | ---: |", ...phases, "", "| Run | Model | Arm | # | Fixture | Action | Calls | Cost | Result | Re-frozen | Replayed hash | Saved hash |", "| --- | --- | --- | ---: | --- | --- | ---: | ---: | --- | --- | --- | --- |", ...runs, "", "| Run | Fixture | # | Capture hash | Engine / observed calls | Verdict | Fixture | Result | Error |", "| --- | --- | ---: | --- | --- | --- | --- | --- | --- |", ...replays].join("\n"));
    return;
  }
  throw new Error("usage: 230-evidence.mjs distill OUT.json LABEL=DIR ... | table IN.json");
}

await main();
