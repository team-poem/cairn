import { VERSIONS } from "./server.mjs";

const TIERS = ["navigation", "form", "stateful"];
const ARMS = ["agent", "cairn"];

/** v3 changes one control of one journey (#230); a schedule that puts another tier on v3 asks for a change that does not exist. */
function validateVersionTiers(tiers, versions, fail) {
  if (versions.includes("v3") && tiers.some((tier) => tier !== "stateful")) fail("fixture version v3 exists only for the stateful tier");
}

function validateBudget(llm, fail) {
  if (!Number.isSafeInteger(llm.maxCalls) || llm.maxCalls < 1) fail("maxCalls");
  if (llm.budgetMode === "calls") {
    if (llm.backend !== "codex") fail("call-only budgets require the codex backend");
    if (llm.maxCostUsd !== undefined) fail("call-only budgets cannot declare maxCostUsd");
  } else {
    if (llm.budgetMode !== undefined) fail("budgetMode");
    if (!Number.isFinite(llm.maxCostUsd) || llm.maxCostUsd <= 0) fail("maxCostUsd stopping threshold");
  }
  if (llm.reasoningEffort !== undefined) {
    if (llm.backend !== "codex") fail("reasoningEffort requires the codex backend");
    if (!["low", "medium", "high"].includes(llm.reasoningEffort)) fail("reasoningEffort");
  }
}

/**
 * The cost comparison (#214) shares the reliability config's fixtures and latency, and adds the
 * two things a comparison needs: which arms to run, and when the app changes. `fixtureVersions`
 * is one entry per run, so "the app changed at run k" is a property of the schedule rather than
 * of the invocation — both arms then meet the same change on the same run.
 */
export function validateCostConfig(config) {
  const fail = (message) => { throw new Error(`Invalid cost configuration: ${message}`); };
  if (!config || config.mode !== "cost") fail("mode");
  if (!Number.isSafeInteger(config.runs) || config.runs < 2) fail("runs must be at least 2; one run cannot show a crossover");
  if (!Array.isArray(config.tiers) || !config.tiers.length || new Set(config.tiers).size !== config.tiers.length || config.tiers.some((tier) => !TIERS.includes(tier))) fail("tiers");
  if (!Array.isArray(config.arms) || !config.arms.length || new Set(config.arms).size !== config.arms.length || config.arms.some((arm) => !ARMS.includes(arm))) fail("arms");
  if (!Array.isArray(config.fixtureVersions) || config.fixtureVersions.length !== config.runs || config.fixtureVersions.some((version) => !VERSIONS.includes(version))) fail("fixtureVersions must name a version for every run");
  if (config.fixtureVersions[0] !== "v1") fail("the first run must be v1: it is the canonical discovery both arms start from");
  validateVersionTiers(config.tiers, config.fixtureVersions, fail);
  if (!/^[a-f0-9]{40}$/.test(config.engineCommit ?? "")) fail("engineCommit must be a full commit hash");
  for (const kind of ["document", "api"]) {
    const values = config.latency?.[kind];
    if (!Array.isArray(values) || !values.length || values.some((n) => !Number.isFinite(n) || n < 0 || n > 2147483647)) fail(`${kind} latency`);
  }
  if (typeof config.outputDir !== "string" || !config.outputDir) fail("outputDir");
  if (config.maxSteps !== undefined && (!Number.isSafeInteger(config.maxSteps) || config.maxSteps < 1)) fail("maxSteps");
  const llm = config.llm;
  if (llm?.source === "scripted") {
    if (typeof llm.label !== "string" || !llm.label.trim()) fail("scripted source label");
  } else {
    if (llm?.source !== "llm" || typeof llm.backend !== "string" || !llm.backend.trim() || typeof llm.model !== "string" || !llm.model.trim()) fail("explicit LLM backend and model");
    validateBudget(llm, fail);
  }
  return config;
}

export function validateConfig(config) {
  const fail = (message) => { throw new Error(`Invalid benchmark configuration: ${message}`); };
  if (!config || !["discover", "replay", "heal"].includes(config.mode)) fail("mode");
  if (!Number.isSafeInteger(config.runs) || config.runs < 1) fail("runs must be a positive safe integer");
  if (!Array.isArray(config.tiers) || !config.tiers.length || new Set(config.tiers).size !== config.tiers.length || config.tiers.some((tier) => !["navigation", "form", "stateful"].includes(tier))) fail("tiers");
  if (!VERSIONS.includes(config.fixtureVersion)) fail("fixtureVersion");
  validateVersionTiers(config.tiers, [config.fixtureVersion], fail);
  if (!/^[a-f0-9]{40}$/.test(config.engineCommit ?? "")) fail("engineCommit must be a full commit hash");
  for (const kind of ["document", "api"]) {
    const values = config.latency?.[kind];
    if (!Array.isArray(values) || !values.length || values.some((n) => !Number.isFinite(n) || n < 0 || n > 2147483647)) fail(`${kind} latency`);
  }
  if (typeof config.outputDir !== "string" || !config.outputDir) fail("outputDir");
  if (config.mode !== "discover" && (typeof config.captureDir !== "string" || !config.captureDir)) fail("captureDir");
  if (config.maxSteps !== undefined && (!Number.isSafeInteger(config.maxSteps) || config.maxSteps < 1)) fail("maxSteps");
  if (config.mode !== "replay") {
    const llm = config.llm;
    if (llm?.source === "scripted") {
      if (typeof llm.label !== "string" || !llm.label.trim()) fail("scripted source label");
    } else {
      if (llm?.source !== "llm" || typeof llm.backend !== "string" || !llm.backend.trim() || typeof llm.model !== "string" || !llm.model.trim()) fail("explicit LLM backend and model");
      validateBudget(llm, fail);
    }
  }
  return config;
}

export function parseOptions(args) {
  const [mode, ...rest] = args;
  if (!["discover", "replay", "heal", "cost"].includes(mode)) throw new Error("Explicit mode must be discover, replay, heal or cost");
  const names = { "--runs": "runs", "--config": "configPath", "--captures": "captureDir", "--out": "outputDir", "--engine-commit": "engineCommit" };
  const result = { mode };
  for (let i = 0; i < rest.length; i += 2) {
    const key = names[rest[i]];
    const value = rest[i + 1];
    if (!key || !value || value.startsWith("--") || key in result) throw new Error(`Invalid or duplicate option: ${rest[i]}`);
    if (key === "runs" && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)) throw new Error("Invalid run count");
    result[key] = key === "runs" ? Number(value) : value;
  }
  for (const key of ["runs", "configPath", "outputDir", "engineCommit"]) if (!(key in result)) throw new Error(`Missing ${key}`);
  if (!["discover", "cost"].includes(mode) && !result.captureDir) throw new Error("Missing captureDir");
  return result;
}
