// Reproduce the two README charts from attributed Claude totals and recorded Codex runs.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const observations = JSON.parse(await readFile(new URL("./228-codex.json", import.meta.url), "utf8"));
const models = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const traces = models.map((model) => {
  const measurement = observations.measurements.find((row) => row.configuration.llm.model === model);
  assert(measurement, `Missing measurement for ${model}`);
  assert.deepEqual(measurement.configuration.fixtureVersions, ["v1", "v1", "v1", "v2", "v2", "v2"]);
  return Object.fromEntries(["agent", "cairn"].map((arm) => {
    const records = measurement.records.filter((row) => row.tier === "stateful" && row.arm === arm).sort((a, b) => a.index - b.index);
    assert.deepEqual(records.map((row) => row.index), [0, 1, 2, 3, 4, 5]);
    let total = 0;
    return [arm, records.map((row) => {
      assert(row.passed && row.usageComplete && row.healCount === 0 && !row.refrozen);
      assert(Number.isSafeInteger(row.observedUsage.llmCalls) && row.observedUsage.llmCalls >= 0);
      total += row.observedUsage.llmCalls;
      return total;
    })];
  }));
});
for (const trace of traces) assert.deepEqual(trace, traces[0], "Model traces differ; do not collapse them into one chart");
const { agent, cairn } = traces[0];
assert.deepEqual(agent, [7, 14, 21, 28, 35, 42]);
assert.deepEqual(cairn, [7, 7, 7, 7, 7, 7]);

const claude = JSON.parse(await readFile(new URL("./228-claude-calls.json", import.meta.url), "utf8"));
assert.equal(claude.tier, "stateful");
assert.equal(claude.runsPerArm, 6);
assert.deepEqual(claude.models.map((row) => row.model), ["claude-sonnet-5", "claude-opus-5"]);
for (const row of claude.models) {
  assert.equal(row.agentCalls, 42);
  assert.equal(row.cairnCalls, 7);
}

const groups = [
  { file: "228-claude-calls.svg", provider: "Claude", names: "Sonnet 5 · Opus 5", agent: claude.models[0].agentCalls, cairn: claude.models[0].cairnCalls, basis: "Totals reported in the PR author's original README." },
  { file: "228-calls.svg", provider: "Codex", names: "Sol · Terra · Luna", agent: agent.at(-1), cairn: cairn.at(-1), basis: "Totals summed from the recorded runs." },
];
const maximum = Math.max(...groups.flatMap((group) => [group.agent, group.cairn]));
for (const group of groups) {
  const bars = [
    { label: "Discover every run", calls: group.agent, y: 113, color: "#e0aa6e" },
    { label: "Discover + replay", calls: group.cairn, y: 183, color: "#7ddab0" },
  ];
  await writeFile(new URL(`./${group.file}`, import.meta.url), `<svg width="1200" height="260" viewBox="0 0 1200 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">${group.provider}: ${group.agent} LLM calls versus ${group.cairn} over six checkout runs</title>
  <desc id="desc">${group.names}. Each model used ${group.agent} calls for six discoveries and ${group.cairn} calls for one discovery followed by five replays. These are per-model totals, not a sum or average across models. ${group.basis} Both provider charts use the same zero-based scale.</desc>
  <rect width="1200" height="260" rx="20" fill="#0b1019"/>
  <g font-family="ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial, sans-serif">
    <text x="40" y="49" fill="#ffffff" font-size="30" font-weight="600">${group.provider}</text>
    <text x="40" y="80" fill="#8fa0b8" font-size="20">${group.names}</text>
    <text x="1160" y="52" text-anchor="end" fill="#8fa0b8" font-size="21">LLM calls / model · 6 runs</text>
    <line x1="310" y1="105" x2="310" y2="231" stroke="#8fa0b8"/>
    ${bars.map((bar) => {
      const width = bar.calls / maximum * 760;
      return `<text x="40" y="${bar.y + 31}" fill="#dce4ef" font-size="24">${bar.label}</text>
    <rect x="310" y="${bar.y}" width="${width}" height="44" rx="5" fill="${bar.color}"/>
    <text x="${310 + width + 18}" y="${bar.y + 32}" fill="${bar.color}" font-size="30" font-weight="600">${bar.calls}</text>`;
    }).join("\n    ")}
  </g>
</svg>
`);
}
