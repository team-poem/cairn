import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const tiers = ["navigation", "form", "stateful"];
export const latency = { document: [20], api: [40] };
export const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
export const load = (root, path) => import(pathToFileURL(join(root, path)).href);
export async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

export async function buildHash(root) {
  const directory = join(root, "packages/harness/dist");
  const hash = createHash("sha256");
  async function visit(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.name.endsWith(".js")) {
        hash.update(relative(directory, file).split(sep).join("/"));
        hash.update(await readFile(file));
      }
    }
  }
  await visit(directory);
  return hash.digest("hex");
}

export function toolchain() {
  const mcp = process.env.CAIRN_MCP_ENTRY;
  if (!mcp) throw new Error("Set CAIRN_MCP_ENTRY to the installed chrome-devtools-mcp@1.3.0 executable JS file");
  const chromePath = process.env.CHROME_PATH ?? (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "win32" ? join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe") : "/usr/bin/google-chrome");
  const version = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const mcpVersion = version(process.execPath, [mcp, "--version"]);
  if (mcpVersion !== "1.3.0") throw new Error(`Expected MCP 1.3.0, received ${mcpVersion}`);
  const chrome = process.platform === "win32"
    ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Item -LiteralPath $env:CAIRN_CHROME_BINARY).VersionInfo.ProductVersion"], {
      env: { ...process.env, CAIRN_CHROME_BINARY: chromePath }, encoding: "utf8", timeout: 15000,
    }).trim()
    : version(chromePath, ["--version"]);
  if (!chrome) throw new Error("Could not determine the installed Chrome version");
  return {
    mcp: resolve(mcp), chromePath,
    environment: { node: process.version, chrome, mcp: mcpVersion, platform: process.platform, arch: process.arch },
  };
}

// The measurement code and fixtures are loaded from one revision. Only public
// built engine imports change between the two child processes.
export async function measure({ engineRoot, fixtureRoot, outputDir, captureDir, mode, signal }) {
  const [{ runBenchmark }, { fixtureInfo, startFixture }, { createLlm }, engine] = await Promise.all([
    load(fixtureRoot, "bench/local/runner.mjs"), load(fixtureRoot, "bench/local/server.mjs"),
    load(fixtureRoot, "bench/local/llm.mjs"), load(engineRoot, "packages/harness/dist/index.js"),
  ]);
  const tools = toolchain();
  const commit = git(engineRoot, "rev-parse", "HEAD");
  const config = {
    mode, runs: 1, tiers, fixtureVersion: "v1", latency, maxSteps: 20,
    llm: { source: "scripted", label: "ci-local-fixtures" },
    engineCommit: commit, outputDir, ...(captureDir ? { captureDir } : {}), signal,
  };
  const report = await runBenchmark(config, {
    engine: { commit, version: engine.ENGINE_VERSION, buildHash: await buildHash(engineRoot), dirty: Boolean(git(engineRoot, "status", "--porcelain")) },
    info: tools.environment, fixtureInfo, startFixture, createLlm,
    discover: engine.discover, runScenario: engine.runScenario, saveSkillFile: engine.saveSkillFile,
    createDriver: () => new engine.ChromeDevToolsDriver({ command: process.execPath, args: [tools.mcp, "--isolated", "--headless", "--executablePath", tools.chromePath, "--no-usage-statistics"] }),
  });
  await mkdir(outputDir, { recursive: true });
  await writeJson(join(outputDir, "results.json"), report);
  return report;
}

export function successful(report) {
  return !report.incomplete && report.attempted === tiers.length && report.records.length === tiers.length
    && report.records.every(row => row.passed);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [engineRoot, fixtureRoot, outputDir, mode, captureDir] = process.argv.slice(2).map((value, index) => index === 3 ? value : resolve(value));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  const abort = () => controller.abort();
  process.once("SIGTERM", abort); process.once("SIGINT", abort);
  try {
    const report = await measure({ engineRoot, fixtureRoot, outputDir, mode, captureDir, signal: controller.signal });
    if (!successful(report)) process.exitCode = 1;
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { clearTimeout(timer); process.removeListener("SIGTERM", abort); process.removeListener("SIGINT", abort); }
}
