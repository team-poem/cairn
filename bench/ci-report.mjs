const SIZE_METRICS = ["packageBytes", "unpackedBytes", "browserBytes", "browserGzipBytes"];
const percentChange = (base, head) => (head - base) / base * 100;

function summarize(records) {
  const times = records.map(record => record.elapsedMs).sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  return {
    runs: records.length,
    failures: records.filter(record => !record.passed).length,
    medianMs: times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2,
    p95Ms: times[Math.ceil(times.length * 0.95) - 1],
    llmCalls: records.reduce((sum, record) => sum + record.llmCalls, 0),
    observedLlmCalls: records.reduce((sum, record) => sum + record.observedLlmCalls, 0),
  };
}

/** Compare paired measurements; byte deltas are signed head minus base. */
export function compareReports(base, head) {
  return {
    tiers: base.workload.captures.map(({ tier }) => {
      const before = summarize(base.records.filter(record => record.tier === tier));
      const after = summarize(head.records.filter(record => record.tier === tier));
      const deltaMs = after.medianMs - before.medianMs;
      return { tier, base: before, head: after, deltaMs,
        percent: percentChange(before.medianMs, after.medianMs),
        status: before.failures || after.failures ? "invalid" : deltaMs < 0 ? "improved" : deltaMs > 0 ? "regressed" : "unchanged",
      };
    }),
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
