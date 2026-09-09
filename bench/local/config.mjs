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
  return config;
}
