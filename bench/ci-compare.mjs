import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build, version as esbuildVersion } from "esbuild";
import { collectReplays, measuredRounds } from "./ci-sampling.mjs";
import { compareReports, renderComparison } from "./ci-report.mjs";
import { buildHash, git, load, tiers, latency, toolchain, writeJson } from "./ci-worker.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [baseArg, headArg, outArg] = process.argv.slice(2);
if (!baseArg || !headArg || !outArg || process.argv.length !== 5) {
  throw new Error("Usage: node bench/ci-compare.mjs BASE_CHECKOUT HEAD_CHECKOUT NEW_OUTPUT_DIRECTORY");
}
const baseRoot = resolve(baseArg), headRoot = resolve(headArg), out = resolve(outArg);
await mkdir(dirname(out), { recursive: true });
await mkdir(out); // Never mix samples with an earlier invocation.
const runs = measuredRounds;
const baseCommit = git(baseRoot, "rev-parse", "HEAD"), headCommit = git(headRoot, "rev-parse", "HEAD");
let markdown = `# Cairn PR benchmarks\n\nBefore: ${baseCommit}\nAfter: ${headCommit}\n\nMeasurement did not complete. See the raw artifacts and job log.\n`;

async function sizes(root, side) {
  const destination = join(out, `${side}-package`);
  await mkdir(destination);
  const metadata = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], {
    cwd: join(root, "packages/harness"), encoding: "utf8", timeout: 60000,
  }));
  // npm 10 returns an array; npm 12 keys the same entries by package name.
  const entries = Object.values(metadata);
  if (entries.length !== 1) throw new Error("Expected exactly one packed engine");
  const [packed] = entries;
  const result = await build({ entryPoints: [join(root, "packages/harness/dist/browser.js")], bundle: true, write: false, minify: true, platform: "browser", format: "esm", target: "es2022" });
  const bytes = result.outputFiles[0].contents;
  return { packageBytes: packed.size, unpackedBytes: packed.unpackedSize, browserBytes: bytes.length, browserGzipBytes: gzipSync(bytes).length };
}

async function attempt(root, label, mode, captures) {
  const destination = join(out, label);
  const args = [join(here, "ci-worker.mjs"), root, baseRoot, destination, mode, ...(captures ? [captures] : [])];
  let commandError;
  try { execFileSync(process.execPath, args, { stdio: "inherit", timeout: 240000 }); }
  catch (error) { commandError = error; }
  let report;
  try { report = JSON.parse(await readFile(join(destination, "results.json"), "utf8")); }
  catch { throw commandError ?? new Error(`Missing measurement: ${label}`); }
  return { report, failed: Boolean(commandError) };
}

try {
  const environment = { ...toolchain().environment, esbuild: esbuildVersion };
  const baseSizes = await sizes(baseRoot, "base"), headSizes = await sizes(headRoot, "head");
  await writeJson(join(out, "sizes.json"), { baseCommit, headCommit, base: baseSizes, head: headSizes });
  const discovery = await attempt(baseRoot, "discovery", "discover");
  if (discovery.failed || discovery.report.records.some(row => !row.passed)) throw new Error("Baseline scripted discovery failed; no comparable canonical captures");
  const captures = join(out, "discovery/captures/run-1");
  const { fixtureInfo } = await load(baseRoot, "bench/local/server.mjs");
  const workload = {
    fixtureHash: createHash("sha256").update(JSON.stringify(tiers.map(tier => fixtureInfo(tier, "v1")))).digest("hex"),
    captures: discovery.report.records.map(row => ({ tier: row.tier, scenarioHash: row.scenarioHash })), runs, latency,
    fixtureCommit: baseCommit,
  };
  const reports = {
    base: { schemaVersion: 1, commit: baseCommit, dirty: Boolean(git(baseRoot, "status", "--porcelain")), buildHash: await buildHash(baseRoot), environment, workload, sizes: baseSizes, records: [], incomplete: false },
    head: { schemaVersion: 1, commit: headCommit, dirty: Boolean(git(headRoot, "status", "--porcelain")), buildHash: await buildHash(headRoot), environment, workload, sizes: headSizes, records: [], incomplete: false },
  };
  const { failed, warmupFailed } = await collectReplays({
    reports, attempt, baseRoot, headRoot, captures, environment, workload, fixtureInfo,
  });
  // Warmup failures invalidate the check even if the later attempts succeed.
  await writeJson(join(out, "paired.json"), { ...reports, warmupFailed });
  if (warmupFailed) throw new Error("A warmup failed; timing comparisons are withheld");
  const comparison = compareReports(reports.base, reports.head);
  markdown = renderComparison(comparison);
  if (failed) markdown += "\n**FAILED: at least one warmup or measured replay failed. Timing is not evidence of improvement.**\n";
  if (failed || comparison.tiers.some(row => row.status === "invalid")) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(join(out, "comparison.md"), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
}
