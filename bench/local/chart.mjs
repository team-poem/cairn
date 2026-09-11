/**
 * A cost comparison as one picture: cumulative spend against the run index, one line per arm.
 *
 * The chart is drawn from a `cost-comparison` report and nothing else, so the README graph can be
 * regenerated from the JSON that produced it rather than being redrawn by hand. It refuses to draw
 * a comparison the report itself withheld, for the same reason the report withholds it: a line that
 * looks like a measurement has to be one.
 */
const PALETTE = { ink: "#ffffff", muted: "#8fa0b8", grid: "#1c2434", agent: "#e0aa6e", cairn: "#7ddab0" };
const FONT = "ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial, sans-serif";
const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const money = (value) => `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;

export function renderCostChart(report, { tier, width = 1200, height = 520 } = {}) {
  if (report?.kind !== "cost-comparison") throw new Error("Not a cost comparison report");
  const summary = report.summaries.find((entry) => entry.tier === (tier ?? report.summaries[0]?.tier));
  if (!summary) throw new Error(`No summary for tier ${tier}`);
  if (!summary.comparable) throw new Error(`Nothing to draw: the comparison was withheld because ${summary.comparableNote}`);
  const arms = ["agent", "cairn"].map((name) => ({ name, points: summary.arms[name].cumulative }));
  const runs = arms[0].points.length;
  const top = Math.max(...arms.flatMap((arm) => arm.points.map((point) => point.costUsd)));
  const box = { left: 96, right: width - 40, top: 96, bottom: height - 76 };
  const x = (index) => box.left + (runs === 1 ? 0 : (index * (box.right - box.left)) / (runs - 1));
  const y = (value) => box.bottom - (top === 0 ? 0 : (value / top) * (box.bottom - box.top));
  const ticks = Array.from({ length: 5 }, (_, index) => (top * index) / 4);

  const gridlines = ticks.map((value) => `<line x1="${box.left}" y1="${y(value).toFixed(1)}" x2="${box.right}" y2="${y(value).toFixed(1)}" stroke="${PALETTE.grid}" stroke-width="1"/>
    <text x="${box.left - 14}" y="${(y(value) + 5).toFixed(1)}" text-anchor="end" fill="${PALETTE.muted}" font-family="${FONT}" font-size="15">${money(value)}</text>`).join("\n    ");
  const runLabels = arms[0].points.map((_, index) => `<text x="${x(index).toFixed(1)}" y="${box.bottom + 34}" text-anchor="middle" fill="${PALETTE.muted}" font-family="${FONT}" font-size="15">${index + 1}</text>`).join("\n    ");
  const lines = arms.map((arm) => {
    const path = arm.points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)} ${y(point.costUsd).toFixed(1)}`).join(" ");
    const dots = arm.points.map((point, index) => `<circle cx="${x(index).toFixed(1)}" cy="${y(point.costUsd).toFixed(1)}" r="5" fill="${PALETTE[arm.name]}"/>`).join("");
    const last = arm.points.at(-1);
    return `<path d="${path}" fill="none" stroke="${PALETTE[arm.name]}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    <text x="${(x(runs - 1) - 12).toFixed(1)}" y="${(y(last.costUsd) - 18).toFixed(1)}" text-anchor="end" fill="${PALETTE[arm.name]}" font-family="${FONT}" font-size="19" font-weight="600">${escape(arm.name)} ${money(last.costUsd)}</text>`;
  }).join("\n    ");
  // Kept inside the plot: above it the label runs into the subtitle.
  const crossover = summary.crossover === null
    ? `<text x="${box.left + 12}" y="${box.top + 22}" fill="${PALETTE.muted}" font-family="${FONT}" font-size="15">no crossover</text>`
    : `<line x1="${x(summary.crossover).toFixed(1)}" y1="${box.top}" x2="${x(summary.crossover).toFixed(1)}" y2="${box.bottom}" stroke="${PALETTE.muted}" stroke-width="1.5" stroke-dasharray="5 6"/>
    <text x="${(x(summary.crossover) + 12).toFixed(1)}" y="${box.top + 22}" fill="${PALETTE.muted}" font-family="${FONT}" font-size="15">cheaper from run ${summary.crossover + 1}</text>`;

  const model = report.configuration.llm?.model ?? "unknown model";
  const changed = report.configuration.fixtureVersions.findIndex((version) => version !== report.configuration.fixtureVersions[0]);
  const churn = changed === -1 ? "the app never changed" : `the app changed at run ${changed + 1}`;
  const label = `Cumulative cost over ${runs} runs of the ${summary.tier} journey with ${model}: discovering every run reaches ${money(arms[0].points.at(-1).costUsd)}, while discovering once and replaying stays at ${money(arms[1].points.at(-1).costUsd)}. ${churn}.`;
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escape(label)}">
  <rect width="${width}" height="${height}" fill="#0b1019"/>
  <text x="${box.left}" y="46" fill="${PALETTE.ink}" font-family="${FONT}" font-size="25" font-weight="600">Cumulative LLM cost, ${escape(summary.tier)} journey</text>
  <text x="${box.left}" y="72" fill="${PALETTE.muted}" font-family="${FONT}" font-size="16">${escape(model)} · ${escape(churn)} · cost as the provider priced it</text>
  ${gridlines}
  ${crossover}
  ${lines}
  ${runLabels}
  <text x="${((box.left + box.right) / 2).toFixed(1)}" y="${height - 22}" text-anchor="middle" fill="${PALETTE.muted}" font-family="${FONT}" font-size="15">run</text>
</svg>
`;
}
