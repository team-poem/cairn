// file: bench/local-chart.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCostChart } from "./local/chart.mjs";

const point = (index, costUsd) => ({ index, costUsd, tokens: 100 * (index + 1), calls: 1 });
const report = (patch = {}) => ({
  kind: "cost-comparison",
  configuration: { llm: { source: "llm", model: "a-model" }, fixtureVersions: ["v1", "v1", "v2", "v2"] },
  summaries: [{
    tier: "navigation", runs: 4, comparable: true, comparableNote: null, costMeasured: true, crossover: 1,
    arms: {
      agent: { cumulative: [point(0, 0.1), point(1, 0.2), point(2, 0.3), point(3, 0.4)] },
      cairn: { cumulative: [point(0, 0.1), point(1, 0.1), point(2, 0.12), point(3, 0.12)] },
    },
  }],
  ...patch,
});

test("costChartDrawsBothArmsAndSaysWhatItIs", () => {
  const svg = renderCostChart(report());
  assert.match(svg, /^<svg width="1200" height="520"/);
  assert.equal((svg.match(/<path /g) ?? []).length, 2);
  assert.equal((svg.match(/<circle /g) ?? []).length, 8);
  assert.match(svg, /agent \$0\.400/);
  assert.match(svg, /cairn \$0\.120/);
  assert.match(svg, /cheaper from run 2/);
  // A reader without the picture still gets the finding, and the caption names the schedule the
  // number belongs to rather than presenting it as a general saving.
  assert.match(svg, /role="img" aria-label="Cumulative cost over 4 runs of the navigation journey with a-model: discovering every run reaches \$0\.400, while discovering once and replaying stays at \$0\.120\. the app changed at run 3\./);
  assert.match(svg, /a-model · the app changed at run 3/);
});

test("costChartRefusesToDrawAComparisonTheReportWithheld", () => {
  const withheld = report();
  withheld.summaries[0].comparable = false;
  withheld.summaries[0].comparableNote = "a run failed, and a failed run costs nothing";
  assert.throws(() => renderCostChart(withheld), /a run failed/);
  assert.throws(() => renderCostChart({ kind: "reliability" }), /Not a cost comparison/);
  assert.throws(() => renderCostChart(report(), { tier: "form" }), /No summary for tier form/);
});

test("costChartSaysWhenNothingChangedUnderTheFreeze", () => {
  const steady = report({ configuration: { llm: { model: "a-model" }, fixtureVersions: ["v1", "v1", "v1", "v1"] } });
  const svg = renderCostChart(steady);
  assert.match(svg, /the app never changed/);
  assert.doesNotMatch(svg, /changed at run/);
});

test("costChartEscapesWhatItPrints", () => {
  const hostile = report({ configuration: { llm: { model: 'a "model" <script>' }, fixtureVersions: ["v1", "v1", "v1", "v1"] } });
  const svg = renderCostChart(hostile);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /a &quot;model&quot; &lt;script&gt;/);
});

test("costChartSaysNoCrossoverWhenTheMeasuredArmsNeverCross", () => {
  const tied = report();
  tied.summaries[0].crossover = null;
  tied.summaries[0].arms.cairn.cumulative = structuredClone(tied.summaries[0].arms.agent.cumulative);
  const svg = renderCostChart(tied);
  assert.match(svg, /no crossover/);
  assert.doesNotMatch(svg, /cheaper from run|stroke-dasharray/);
});

test("costReportWritesAnHonestChartForAMeasuredScheduleWithoutACrossover", async (t) => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeReport } = await import("./local/report.mjs");
  const directory = await mkdtemp(join(tmpdir(), "cairn-no-crossover-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const slower = report();
  slower.summaries[0].crossover = null;
  slower.summaries[0].arms.cairn.cumulative = [point(0, 0.2), point(1, 0.3), point(2, 0.4), point(3, 0.5)];
  const paths = await writeReport(slower, directory, () => "measured schedule");
  const svg = await readFile(paths.charts[0], "utf8");
  assert.match(svg, /no crossover/);
  assert.doesNotMatch(svg, /cheaper from run|stroke-dasharray/);
});
