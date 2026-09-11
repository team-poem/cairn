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

assert.equal(claude.replaysPerModel, 5);
assert.equal(claude.replayCallsPerModel, 0);
const groups = [
  {
    file: "228-claude-calls.svg", provider: "Claude", names: "Sonnet 5 · Opus 5",
    // Only the baseline and six-run discovery total are known. The dashed connector is a guide.
    agent: [[0, 0], [6, claude.models[0].agentCalls]],
    cairn: [[0, 0], ...Array.from({ length: 6 }, (_, i) => [i + 1, claude.models[0].cairnCalls])],
    sparse: true,
    basis: "The author reported the six-run totals and zero calls on all five replays. Intermediate discovery counts are unavailable; the dashed line only connects the baseline and final total.",
  },
  {
    file: "228-calls.svg", provider: "Codex", names: "Sol · Terra · Luna",
    agent: [[0, 0], ...agent.map((value, i) => [i + 1, value])],
    cairn: [[0, 0], ...cairn.map((value, i) => [i + 1, value])],
    sparse: false, basis: "Each point is summed from the recorded runs.",
  },
];
const x = (run) => 80 + run * 165;
const y = (calls) => 315 - calls / 42 * 210;
const line = (points, color, dashed) => `
    <polyline points="${points.map(([run, calls]) => `${x(run)},${y(calls)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="4"${dashed ? ' stroke-dasharray="8 7"' : ""}/>
    ${points.map(([run, calls]) => `<circle cx="${x(run)}" cy="${y(calls)}" r="5" fill="${color}"/>`).join("\n    ")}`;
for (const group of groups) {
  await writeFile(new URL(`./${group.file}`, import.meta.url), `<svg width="1200" height="390" viewBox="0 0 1200 390" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">${group.provider}: cumulative LLM calls over six checkout runs</title>
  <desc id="desc">${group.names}. Each model used 42 calls for six discoveries and 7 calls for one discovery followed by five replays. These are per-model counts, not a sum or average across models. ${group.basis} Both provider charts use the same scale.</desc>
  <rect width="1200" height="390" rx="20" fill="#0b1019"/>
  <g font-family="ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial, sans-serif">
    <text x="40" y="45" fill="#ffffff" font-size="30" font-weight="600">${group.provider}</text>
    <text x="40" y="75" fill="#8fa0b8" font-size="20">${group.names}</text>
    <text x="1160" y="47" text-anchor="end" fill="#8fa0b8" font-size="21">Cumulative LLM calls / model</text>
    ${[0, 7, 21, 42].map((calls) => `<line x1="80" y1="${y(calls)}" x2="1070" y2="${y(calls)}" stroke="#263043"/>
    <text x="64" y="${y(calls) + 6}" text-anchor="end" fill="#8fa0b8" font-size="18">${calls}</text>`).join("\n    ")}
    ${line(group.agent, "#e0aa6e", group.sparse)}
    ${line(group.cairn, "#7ddab0", false)}
    <text x="1090" y="115" fill="#e0aa6e" font-size="30" font-weight="600">42</text>
    <text x="805" y="185" fill="#e0aa6e" font-size="21">Discover every run</text>
    <text x="1090" y="290" fill="#7ddab0" font-size="30" font-weight="600">7</text>
    <text x="835" y="262" fill="#7ddab0" font-size="21">Discover + replay</text>
    ${Array.from({ length: 7 }, (_, run) => `<text x="${x(run)}" y="345" text-anchor="middle" fill="#8fa0b8" font-size="18">${run}</text>`).join("\n    ")}
    <text x="1110" y="345" fill="#8fa0b8" font-size="18">Run</text>
    ${group.sparse ? '<text x="80" y="376" fill="#8fa0b8" font-size="17">Dashed: endpoints only; intermediate discovery counts unavailable.</text>' : ""}
  </g>
</svg>
`.replace(/[ \t]+\n/g, "\n"));
}
