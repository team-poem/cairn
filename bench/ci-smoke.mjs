import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { measure, successful } from "./ci-worker.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? "bench/results/ci-smoke");
await mkdir(dirname(out), { recursive: true });
await mkdir(out);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 240000);
const abort = () => controller.abort();
process.once("SIGTERM", abort); process.once("SIGINT", abort);
try {
  const common = { engineRoot: root, fixtureRoot: root, signal: controller.signal };
  const discovery = await measure({ ...common, mode: "discover", outputDir: join(out, "discovery") });
  if (!successful(discovery)) throw new Error("Local scripted discovery failed; inspect the discovery results.json");
  const replay = await measure({ ...common, mode: "replay", outputDir: join(out, "replay"), captureDir: join(out, "discovery/captures/run-1") });
  if (!successful(replay)) throw new Error("Local replay failed; inspect the replay results.json");
  console.log("PASS: navigation, async form and stateful journey; replay made zero LLM calls");
} catch (error) { console.error(error); process.exitCode = 1; }
finally { clearTimeout(timer); process.removeListener("SIGTERM", abort); process.removeListener("SIGINT", abort); }
