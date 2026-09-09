import { readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateScenario(scenario, mode = "replay") {
  if (!scenario || typeof scenario.name !== "string" || !Array.isArray(scenario.steps) || !scenario.steps.length || !Array.isArray(scenario.assertions) || !scenario.assertions.length || scenario.truncated) throw new Error("Invalid or incomplete scenario");
  const kinds = ["goto", "click", "doubleClick", "hover", "type", "select", "pressKey", "scroll", "waitFor"];
  for (const step of scenario.steps) {
    if (!step || !kinds.includes(step.kind)) throw new Error("Unsupported scenario step");
    if (step.kind === "goto" && typeof step.url !== "string") throw new Error("Invalid navigation step");
    if (["click", "doubleClick", "hover", "type", "select"].includes(step.kind) && (!step.target || typeof step.target !== "object")) throw new Error("Invalid target");
    if (step.kind === "type" && typeof step.text !== "string") throw new Error("Invalid typed text");
  }
  for (const check of scenario.assertions) {
    if (!check || !["navigated", "no-console-errors", "no-failed-requests", "request-status", "expect"].includes(check.kind)) throw new Error("Unsupported scenario assertion");
    if (mode === "replay" && check.kind === "expect") throw new Error("Semantic LLM checks are forbidden in replay");
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
