import { git } from "./ci-worker.mjs";
import { compareSizes, renderSizeTable } from "./ci-report.mjs";

// Inspect the named commit, not an import error or a missing checkout file.
// A partial/invalid existing harness must still fail the normal measurement.
export function baselineHasHarness(root, commit) {
  const entry = git(root, "ls-tree", commit, "--", "bench/local");
  if (!entry) {
    const parent = git(root, "ls-tree", commit, "--", "bench");
    if (parent && !/^040000 tree [a-f0-9]+\tbench$/.test(parent)) throw new Error("Baseline benchmark path is not a directory");
    return false;
  }
  if (!/^040000 tree [a-f0-9]+\tbench\/local$/.test(entry)) throw new Error("Baseline benchmark harness is not a directory");
  return true;
}

const requireValid = condition => { if (!condition) throw new Error("Invalid size-only comparison"); };
const keys = (value, expected) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...expected].sort().join(",");
const metrics = ["packageBytes", "unpackedBytes", "browserBytes", "browserGzipBytes"];

/** Separate schema: unavailable replay is never a zero-sample success. */
export function renderSizeOnlyComparison(pair, { includeContext = true } = {}) {
  requireValid(keys(pair, ["schemaVersion", "kind", "replay", "environment", "base", "head"]));
  requireValid(pair.schemaVersion === 1 && pair.kind === "size-only");
  requireValid(keys(pair.replay, ["status", "reason"])
    && pair.replay.status === "unavailable" && pair.replay.reason === "baseline-harness-absent");
  requireValid(keys(pair.environment, ["node", "esbuild", "platform", "arch"])
    && Object.values(pair.environment).every(value => typeof value === "string" && value.length > 0 && value.length <= 512));
  for (const side of [pair.base, pair.head]) {
    requireValid(keys(side, ["commit", "dirty", "buildHash", "sizes"]));
    requireValid(typeof side.commit === "string" && /^[a-f0-9]{40}$/.test(side.commit));
    requireValid(typeof side.dirty === "boolean" && typeof side.buildHash === "string" && /^[a-f0-9]{64}$/.test(side.buildHash));
    requireValid(keys(side.sizes, metrics) && metrics.every(metric => Number.isSafeInteger(side.sizes[metric]) && side.sizes[metric] >= 0));
  }
  return [
    "# PR size comparison", "", `Before: ${pair.base.commit}`, `After: ${pair.head.commit}`, "",
    "**Replay unavailable:** the baseline commit has no local benchmark harness. Only package and bundle sizes were measured; replay timing, pass counts and LLM usage were not measured.", "",
    ...renderSizeTable(compareSizes(pair.base.sizes, pair.head.sizes)), "",
    ...(includeContext ? [
      `Uncommitted changes before / after: ${pair.base.dirty} / ${pair.head.dirty}.`,
      `Built JS SHA-256 before: ${pair.base.buildHash}`, `Built JS SHA-256 after: ${pair.head.buildHash}`, "",
    ] : []),
  ].join("\n");
}
