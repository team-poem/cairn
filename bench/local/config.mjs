export function validateConfig(config) {
  const fail = (message) => { throw new Error(`Invalid benchmark configuration: ${message}`); };
  if (!config || !["discover", "replay", "heal"].includes(config.mode)) fail("mode");
  if (!Number.isSafeInteger(config.runs) || config.runs < 1) fail("runs must be a positive safe integer");
  if (!Array.isArray(config.tiers) || !config.tiers.length || new Set(config.tiers).size !== config.tiers.length || config.tiers.some((tier) => !["navigation", "form", "stateful"].includes(tier))) fail("tiers");
  if (!["v1", "v2"].includes(config.fixtureVersion)) fail("fixtureVersion");
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
      if (!Number.isSafeInteger(llm.maxCalls) || llm.maxCalls < 1) fail("maxCalls");
      if (!Number.isFinite(llm.maxCostUsd) || llm.maxCostUsd <= 0) fail("maxCostUsd stopping threshold");
    }
  }
  return config;
}

export function parseOptions(args) {
  const [mode, ...rest] = args;
  if (!["discover", "replay", "heal"].includes(mode)) throw new Error("Explicit mode must be discover, replay or heal");
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
  if (mode !== "discover" && !result.captureDir) throw new Error("Missing captureDir");
  return result;
}
