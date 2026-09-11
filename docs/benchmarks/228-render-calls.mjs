// Reproduce the README chart from the recorded Codex checkout runs, without pricing assumptions.
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

const x = (index) => 86 + index * 190;
const y = (calls) => 420 - calls / 42 * 280;
const line = (values, color, dashed = false) => `
  <polyline points="${values.map((value, index) => `${x(index)},${y(value)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="4"${dashed ? ' stroke-dasharray="9 6"' : ""}/>
  ${values.map((value, index) => `<circle cx="${x(index)}" cy="${y(value)}" r="5" fill="${color}"/>`).join("\n  ")}`;

await writeFile(new URL("./228-calls.svg", import.meta.url), `<svg width="1200" height="520" viewBox="0 0 1200 520" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">Six checkout runs: 42 LLM calls versus 7</title>
  <desc id="desc">Sol, Terra and Luna each produced the same cumulative call counts. Discover every run: 7, 14, 21, 28, 35, 42. Discover once and replay: 7 on every run. Controls were renamed on run 4; no repair was needed. These are individual model traces, not pooled totals.</desc>
  <rect width="1200" height="520" rx="20" fill="#0b1019"/>
  <g font-family="ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial, sans-serif">
    <text x="48" y="52" fill="#ffffff" font-size="30" font-weight="600">Discover once. Replay five times.</text>
    <text x="48" y="84" fill="#8fa0b8" font-size="19">Login → cart → order · Sol, Terra and Luna each produced this trace</text>
    <text x="48" y="119" fill="#8fa0b8" font-size="17">Cumulative LLM calls</text>
    ${[0, 7, 14, 21, 28, 35, 42].map((value) => `<line x1="86" y1="${y(value)}" x2="1036" y2="${y(value)}" stroke="#1c2434"/>
    <text x="70" y="${y(value) + 6}" fill="#8fa0b8" font-size="18" text-anchor="end">${value}</text>`).join("\n    ")}
    <line x1="656" y1="132" x2="656" y2="420" stroke="#8fa0b8" stroke-dasharray="4 7"/>
    <text x="670" y="161" fill="#8fa0b8" font-size="17">Labels changed</text>
    ${line(agent, "#e0aa6e")}
    ${line(cairn, "#7ddab0", true)}
    <text x="1049" y="150" fill="#e0aa6e" font-size="30" font-weight="600">42</text>
    <text x="860" y="219" fill="#e0aa6e" font-size="19">Discover every run</text>
    <text x="1049" y="383" fill="#7ddab0" font-size="30" font-weight="600">7</text>
    <text x="766" y="350" fill="#7ddab0" font-size="19">Discover once, then replay</text>
    ${agent.map((_, index) => `<text x="${x(index)}" y="451" text-anchor="middle" fill="#8fa0b8" font-size="18">${index + 1}</text>`).join("\n    ")}
    <text x="1094" y="451" fill="#8fa0b8" font-size="18">Run</text>
    <text x="48" y="491" fill="#8fa0b8" font-size="18">Five replays · zero LLM calls · no repairs triggered in this fixture</text>
  </g>
</svg>
`);
