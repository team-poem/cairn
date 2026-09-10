const SIZE_METRICS = ["packageBytes", "unpackedBytes", "browserBytes", "browserGzipBytes"];
const percentChange = (base, head) => (head - base) / base * 100;

const TIERS = ["navigation", "form", "stateful"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0 && value.length <= 512;
const requireValid = (condition, field) => { if (!condition) throw new Error(`Invalid CI measurement: ${field}`); };

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function identity(report) {
  requireValid(object(report) && report.schemaVersion === 1, "schemaVersion");
  requireValid(typeof report.commit === "string" && /^[a-f0-9]{40}$/.test(report.commit), "full commit SHA");
  requireValid(object(report.environment), "environment");
  for (const key of ["node", "chrome", "platform", "arch"]) requireValid(text(report.environment[key]), `environment.${key}`);
  requireValid(Object.values(report.environment).every(text), "environment values");
  requireValid(object(report.workload) && text(report.workload.fixtureHash) && Array.isArray(report.workload.captures), "workload");
  for (const capture of report.workload.captures) {
    requireValid(object(capture) && TIERS.includes(capture.tier) && text(capture.scenarioHash), "capture identity");
  }
  return canonical({ environment: report.environment, workload: {
    ...report.workload, captures: [...report.workload.captures].sort((a, b) => a.tier.localeCompare(b.tier)),
  } });
}

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
  const beforeIdentity = identity(base);
  const afterIdentity = identity(head);
  requireValid(JSON.stringify(beforeIdentity) === JSON.stringify(afterIdentity), "environment or workload mismatch");
  return {
    environment: structuredClone(base.environment),
    workload: structuredClone(base.workload),
    tiers: base.workload.captures.map(({ tier }) => {
      const before = summarize(base.records.filter(record => record.tier === tier));
      const after = summarize(head.records.filter(record => record.tier === tier));
      const deltaMs = after.medianMs - before.medianMs;
      return { tier, base: before, head: after, deltaMs,
        percent: percentChange(before.medianMs, after.medianMs),
        status: [before, after].some(side => side.failures || side.llmCalls || side.observedLlmCalls) ? "invalid" : deltaMs < 0 ? "improved" : deltaMs > 0 ? "regressed" : "unchanged",
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
