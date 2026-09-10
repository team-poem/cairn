const SIZE_METRICS = ["packageBytes", "unpackedBytes", "browserBytes", "browserGzipBytes"];
const percentChange = (base, head) => (head - base) / base * 100;

/** Compare paired measurements; byte deltas are signed head minus base. */
export function compareReports(base, head) {
  return {
    baseCommit: base.commit,
    headCommit: head.commit,
    sizes: Object.fromEntries(SIZE_METRICS.map(metric => [metric, {
      base: base.sizes[metric], head: head.sizes[metric],
      delta: head.sizes[metric] - base.sizes[metric],
      percent: percentChange(base.sizes[metric], head.sizes[metric]),
    }])),
  };
}

export function renderComparison(comparison) {
  return JSON.stringify(comparison);
}
