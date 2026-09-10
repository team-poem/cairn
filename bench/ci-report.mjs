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
  if (report.dirty !== undefined) requireValid(typeof report.dirty === "boolean", "workspace dirty flag");
  if (report.buildHash !== undefined) requireValid(typeof report.buildHash === "string" && /^[a-f0-9]{64}$/.test(report.buildHash), "build hash");
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
    for (const field of ["llmCalls", "observedLlmCalls"]) {
      requireValid((record.passed === false && record[field] === null)
        || (Number.isSafeInteger(record[field]) && record[field] >= 0), field);
    }
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
    llmCalls: records.some(record => record.llmCalls === null) ? null : records.reduce((sum, record) => sum + record.llmCalls, 0),
    observedLlmCalls: records.some(record => record.observedLlmCalls === null) ? null : records.reduce((sum, record) => sum + record.observedLlmCalls, 0),
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
        status: [before, after].some(side => side.failures || side.llmCalls !== 0 || side.observedLlmCalls !== 0) ? "invalid" : deltaMs < 0 ? "improved" : deltaMs > 0 ? "regressed" : "unchanged",
      };
    }),
    baseCommit: base.commit,
    headCommit: head.commit,
    provenance: {
      baseDirty: base.dirty ?? null, headDirty: head.dirty ?? null,
      baseBuildHash: base.buildHash ?? null, headBuildHash: head.buildHash ?? null,
    },
    sizes: Object.fromEntries(SIZE_METRICS.map(metric => [metric, {
      base: base.sizes[metric], head: head.sizes[metric],
      delta: head.sizes[metric] - base.sizes[metric],
      percent: percentChange(base.sizes[metric], head.sizes[metric]),
    }])),
  };
}

// Escape artifact text before embedding it in Markdown, including mention syntax.
const cell = value => String(value).replace(/[\r\n\t]/g, " ").replace(/[&<>"'`|\\[\]()!*_#@]/g, character => `&#${character.charCodeAt(0)};`);
const number = value => {
  requireValid(Number.isFinite(value), "rendered number");
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
};
const signed = value => `${value > 0 ? "+" : ""}${number(value)}`;
const percentage = value => value === null ? "n/a" : `${signed(value)}%`;
const usage = value => value === null ? "unknown" : number(value);

/** Render only a comparison freshly derived by compareReports, never artifact Markdown. */
export function renderComparison(comparison, { includeContext = true, includeP95 = true } = {}) {
  const labels = { packageBytes: "Package tarball", unpackedBytes: "Package unpacked", browserBytes: "Browser bundle", browserGzipBytes: "Browser bundle gzip" };
  const sizes = SIZE_METRICS.map(metric => {
    const row = comparison.sizes[metric];
    return `| ${labels[metric]} | ${number(row.base)} | ${number(row.head)} | ${signed(row.delta)} | ${percentage(row.percent)} |`;
  });
  const statuses = { improved: "lower median (informational)", regressed: "higher median (informational)", unchanged: "unchanged", invalid: "invalid: failed or LLM-tainted" };
  const timings = comparison.tiers.map(row => {
    requireValid(TIERS.includes(row.tier) && Object.hasOwn(statuses, row.status), "rendered tier status");
    return `| ${row.tier} | ${number(row.base.runs)} / ${number(row.head.runs)} | ${number(row.base.medianMs)} | ${number(row.head.medianMs)} | ${signed(row.deltaMs)} | ${percentage(row.percent)} |${includeP95 ? ` ${number(row.base.p95Ms)} / ${number(row.head.p95Ms)} |` : ""} ${statuses[row.status]} |`;
  });
  const outcomes = comparison.tiers.map(row => `| ${row.tier} | ${number(row.base.failures)} / ${number(row.head.failures)} | ${usage(row.base.llmCalls)} / ${usage(row.head.llmCalls)} | ${usage(row.base.observedLlmCalls)} / ${usage(row.head.observedLlmCalls)} |`);
  const environment = Object.entries(comparison.environment).map(([key, value]) => `${cell(key)}: ${cell(value)}`).join("; ");
  const captures = comparison.workload.captures.map(capture => `${cell(capture.tier)}: ${cell(capture.scenarioHash)}`).join("; ");
  return [
    "# PR performance comparison", "",
    `Before: ${cell(comparison.baseCommit)}`, `After: ${cell(comparison.headCommit)}`, "",
    comparison.tiers.some(row => row.status === "invalid")
      ? "Invalid timing comparison: measured failures or LLM calls cannot establish a speed improvement."
      : "All measured attempts passed with zero engine-reported and observed LLM calls.", "",
    "## Package size", "",
    "| Size | Before bytes | After bytes | Delta bytes | Change |",
    "| --- | ---: | ---: | ---: | ---: |", ...sizes, "",
    "## Replay elapsed time", "",
    `| Tier | N before / after | Median before ms | Median after ms | Delta ms | Change |${includeP95 ? " p95 before / after ms |" : ""} Status |`,
    `| --- | ---: | ---: | ---: | ---: | ---: |${includeP95 ? " ---: |" : ""} --- |`, ...timings, "",
    "| Tier | Failures before / after | Engine LLM calls before / after | Observed LLM calls before / after |",
    "| --- | ---: | ---: | ---: |", ...outcomes, "",
    ...(includeContext ? [
      "Latency is informational and includes server/browser startup and awaited cleanup. Shared-runner noise and small samples do not establish statistical significance; p95 uses the nearest rank and is descriptive. With four samples p95 is the maximum and remains sensitive to execution order. Fully recorded failed attempts remain in the elapsed-time distribution; unknown LLM usage is not zero. Incomplete output withholds the comparison. A zero baseline has no defined percentage change (n/a).", "",
      "This scripted capture and replay measurement does not establish general application reliability or paid LLM discovery quality.", "",
      "## Provenance", "", environment, "",
      `Uncommitted changes before / after: ${comparison.provenance.baseDirty ?? "unknown"} / ${comparison.provenance.headDirty ?? "unknown"}.`,
      `Built JS SHA-256 before: ${comparison.provenance.baseBuildHash ?? "unknown"}`,
      `Built JS SHA-256 after: ${comparison.provenance.headBuildHash ?? "unknown"}`, "",
      `Fixture: ${cell(comparison.workload.fixtureHash)}`, `Captures: ${captures}`, "",
    ] : []),
  ].join("\n");
}
