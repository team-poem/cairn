import { readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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
  return { scenario: JSON.parse(bytes), metadata };
}
