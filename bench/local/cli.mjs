import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseOptions, validateConfig, validateCostConfig } from "./config.mjs";
import { fixtureInfo, startFixture, reservePort } from "./server.mjs";
import { createLlm } from "./llm.mjs";
import { runBenchmark } from "./runner.mjs";
import { runCostComparison } from "./cost.mjs";
import { writeReport, renderCostMarkdown } from "./report.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
  console.log("npm run bench:local -- <discover|replay|heal|cost> --config FILE --runs N --engine-commit FULL_SHA --out DIRECTORY [--captures DIRECTORY]\nUse a fresh output directory. See bench/local/README.md for configuration and measurement limits.");
} else {
  try {
    const { configPath, ...options } = parseOptions(args);
    const merged = { ...JSON.parse(await readFile(resolve(configPath), "utf8")), ...options, outputDir: resolve(options.outputDir), ...(options.captureDir ? { captureDir: resolve(options.captureDir) } : {}) };
    const config = merged.mode === "cost" ? validateCostConfig(merged) : validateConfig(merged);
    if (config.mode === "discover" && config.fixtureVersion !== "v1") throw new Error("Canonical discovery requires fixtureVersion v1");
    if (config.mode !== "replay" && config.llm.source === "llm" && !["claude-code", "codex"].includes(config.llm.backend)) throw new Error("Supported LLM backends: claude-code, codex");
    try { await stat(config.outputDir); throw new Error("Output directory already exists; use a fresh directory"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const git = (...arguments_) => execFileSync("git", arguments_, { cwd: root, encoding: "utf8" }).trim();
    const commit = git("rev-parse", "HEAD");
    if (commit !== config.engineCommit) throw new Error("Requested engine commit does not match this checkout");
    const hash = createHash("sha256");
    const dist = join(root, "packages/harness/dist");
    async function hashTree(directory) {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await hashTree(path);
        else if (entry.name.endsWith(".js")) { hash.update(path.slice(dist.length)); hash.update(await readFile(path)); }
      }
    }
    await hashTree(dist);
    const { ChromeDevToolsDriver, discover, runScenario, saveSkillFile, ENGINE_VERSION } = await import("../../packages/harness/dist/index.js");
    const driverArgs = ["-y", "chrome-devtools-mcp@1.8.0", "--isolated", "--no-page-id-routing", "--headless"];
    function version(command, arguments_) { try { return execFileSync(command, arguments_, { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } }
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort); process.once("SIGTERM", abort);
    try {
      const run = config.mode === "cost" ? runCostComparison : runBenchmark;
      const report = await run({ ...config, signal: controller.signal }, {
        engine: { version: ENGINE_VERSION, commit, dirty: Boolean(git("status", "--porcelain")), buildHash: hash.digest("hex") },
        info: { driverArgs, chrome: version(process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome", ["--version"]), llmCli: config.mode !== "replay" && config.llm?.source === "llm" ? version(config.llm.backend === "codex" ? "codex" : "claude", ["--version"]) : null },
        fixtureInfo, startFixture, reservePort, createDriver: () => new ChromeDevToolsDriver({ args: driverArgs }), createLlm, discover, runScenario, saveSkillFile,
      });
      const paths = await writeReport(report, config.outputDir, config.mode === "cost" ? renderCostMarkdown : undefined);
      console.log(JSON.stringify({ ...paths, requested: report.requested, attempted: report.attempted, failures: report.records.filter((record) => !record.passed).length, incomplete: report.incomplete }, null, 2));
      if (report.incomplete || report.records.some((record) => !record.passed)) process.exitCode = 1;
    } finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
  } catch (error) { console.error(error.message ?? error); process.exitCode = 1; }
}
