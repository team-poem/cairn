import { readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.length > 0;
const requestCheck = (value) => object(value) && text(value.urlIncludes) && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 && (value.method === undefined || text(value.method));
function condition(value) {
  return object(value) && ["url", "text", "role", "requestStatus"].some((key) => value[key] !== undefined)
    && ["url", "text", "role"].every((key) => value[key] === undefined || text(value[key]))
    && (value.requestStatus === undefined || requestCheck(value.requestStatus));
}

export function validateScenario(scenario, mode = "replay") {
  if (!scenario || typeof scenario.name !== "string" || !Array.isArray(scenario.steps) || !scenario.steps.length || !Array.isArray(scenario.assertions) || !scenario.assertions.length || scenario.truncated) throw new Error("Invalid or incomplete scenario");
  const kinds = ["goto", "click", "doubleClick", "hover", "type", "select", "pressKey", "scroll", "waitFor"];
  for (const step of scenario.steps) {
    if (!step || !kinds.includes(step.kind)) throw new Error("Unsupported scenario step");
    if (step.kind === "goto" && !text(step.url)) throw new Error("Invalid navigation step");
    if (["click", "doubleClick", "hover", "type", "select"].includes(step.kind)) {
      if (!object(step.target) || !["text", "role", "selector"].some((key) => text(step.target[key])) || ["index", "nth"].some((key) => step.target[key] !== undefined && (!Number.isSafeInteger(step.target[key]) || step.target[key] < 0))) throw new Error("Invalid target");
    }
    if (step.kind === "type" && typeof step.text !== "string") throw new Error("Invalid typed text");
    if (step.kind === "select" && typeof step.value !== "string") throw new Error("Invalid selected value");
    if (step.kind === "pressKey" && !text(step.key)) throw new Error("Invalid key");
    if (step.kind === "scroll" && step.direction !== undefined && !["up", "down"].includes(step.direction)) throw new Error("Invalid scroll direction");
    if (step.kind === "waitFor" && (!condition(step.until) || (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs < 0)))) throw new Error("Invalid wait condition");
    if (step.expect !== undefined && !condition(step.expect)) throw new Error("Invalid step expectation");
  }
  for (const check of scenario.assertions) {
    if (!check || !["navigated", "no-console-errors", "no-failed-requests", "request-status", "expect"].includes(check.kind)) throw new Error("Unsupported scenario assertion");
    if (mode === "replay" && check.kind === "expect") throw new Error("Semantic LLM checks are forbidden in replay");
    if (check.kind === "request-status" && !requestCheck(check)) throw new Error("Invalid request assertion");
    if (check.kind === "navigated" && check.to !== undefined && !text(check.to)) throw new Error("Invalid navigation assertion");
    if (check.kind === "expect" && !text(check.criterion)) throw new Error("Invalid semantic assertion");
  }
  return scenario;
}

function validSource(source) {
  return source?.kind === "scripted" ? typeof source.label === "string" && !!source.label.trim()
    : source?.kind === "llm" && typeof source.backend === "string" && !!source.backend.trim() && typeof source.model === "string" && !!source.model.trim();
}

export async function saveCapture(path, scenario, metadata, saveSkillFile) {
  try { await access(path); throw new Error(`Capture already exists: ${path}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await saveSkillFile(path, scenario);
  const bytes = await readFile(path);
  await writeFile(path + ".meta.json", JSON.stringify({ ...metadata, scenarioHash: sha256(bytes) }, null, 2), { flag: "wx" });
}

export async function loadCapture(path, expected) {
  const bytes = await readFile(path, "utf8");
  const metadata = JSON.parse(await readFile(path + ".meta.json", "utf8"));
  const scenario = validateScenario(JSON.parse(bytes), expected.mode);
  if (!metadata || metadata.scenarioHash !== sha256(bytes) || !validSource(metadata.source)) throw new Error("Capture hash or discovery provenance is invalid");
  for (const field of ["tier", "fixtureVersion", "fixtureHash"]) if (metadata[field] !== expected[field]) throw new Error(`Incompatible capture ${field}`);
  const origin = new URL(metadata.captureOrigin);
  if (origin.origin !== metadata.captureOrigin || origin.hostname !== "127.0.0.1" || origin.protocol !== "http:") throw new Error("Capture origin must be local");
  if (scenario.steps[0].kind !== "goto" || scenario.steps.some((step) => step.kind === "goto" && new URL(step.url).origin !== origin.origin)) throw new Error("Capture navigation leaves its fixture origin");
  return { scenario, metadata };
}
