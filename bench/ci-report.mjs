const SIZE_METRICS = ["packageBytes", "unpackedBytes", "browserBytes", "browserGzipBytes"];
const percentChange = (base, head) => {
  const percent = base === 0 ? null : (head - base) / base * 100;
  return Number.isFinite(percent) ? percent : null;
};

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

function validateCounts(report) {
  requireValid(report.incomplete === false, "incomplete measurement");
  const { captures, runs } = report.workload;
  const tiers = new Set(captures.map(capture => capture.tier));
  requireValid(tiers.size > 0 && tiers.size === captures.length, "unique nonempty capture tiers");
  requireValid(Number.isSafeInteger(runs) && runs > 0 && runs <= 10000, "runs per tier");
  requireValid(Array.isArray(report.records) && report.records.length === tiers.size * runs, "complete sample count");
  for (const record of report.records) requireValid(object(record) && tiers.has(record.tier), "record tier");
  for (const tier of tiers) requireValid(report.records.filter(record => record.tier === tier).length === runs, "samples per tier");
}

function validateMeasurements(report) {
  requireValid(object(report.sizes), "sizes");
  for (const metric of SIZE_METRICS) requireValid(Number.isSafeInteger(report.sizes[metric]) && report.sizes[metric] >= 0, metric);
  for (const record of report.records) {
    requireValid(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0 && record.elapsedMs <= Number.MAX_SAFE_INTEGER, "elapsedMs");
    requireValid(typeof record.passed === "boolean", "passed verdict");
    for (const field of ["llmCalls", "observedLlmCalls"]) requireValid(Number.isSafeInteger(record[field]) && record[field] >= 0, field);
  }
  for (const field of ["llmCalls", "observedLlmCalls"]) requireValid(Number.isSafeInteger(report.records.reduce((sum, record) => sum + record[field], 0)), `total ${field}`);
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
  validateCounts(base);
  validateCounts(head);
  validateMeasurements(base);
  validateMeasurements(head);
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
