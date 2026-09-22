import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import {
  ChromeDevToolsDriver,
  createLlmClient,
  discover,
  runScenario,
  saveSkillFile,
  loadSkillFile,
  startTrace,
  ENGINE_VERSION,
} from "cairn-engine";
import { startServer } from "./server.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const output = resolve(directory, process.env.DEMO_OUTPUT ?? ".artifacts");
const port = Number(process.env.PORT ?? 4319);
const maxCalls = Number(process.env.DEMO_MAX_CALLS ?? 24);
const intent =
  "Order one Field notebook. Use Alex Demo as the full name and alex@example.test as the email. Complete checkout and prove POST /api/order returned 200.";
const client = createLlmClient({
  ...(process.env.DEMO_MODEL ? { model: process.env.DEMO_MODEL } : {}),
});
let totalCalls = 0;
let commit = null;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
    encoding: "utf8",
  }).trim();
} catch {
  /* A standalone copy need not be a Git checkout. */
}
const hash = (data) => createHash("sha256").update(data).digest("hex");
const manifest = {
  schemaVersion: 1,
  kind: "recorded-engine-run",
  recordedAt: new Date().toISOString(),
  checkoutCommit: commit,
  model: client.id,
  intent,
  maxCalls,
  costUsd: null,
  complete: false,
  stages: [],
};
const mutationMethods = new Set([
  "goto",
  "click",
  "type",
  "select",
  "hover",
  "scroll",
  "pressKey",
  "waitFor",
]);
const json = async (name, value) =>
  writeFile(resolve(output, name), JSON.stringify(value, null, 2) + "\n");

async function recordStage(id, title, variant, work) {
  const folder = resolve(output, id);
  await mkdir(folder);
  const stage = {
    id,
    title,
    variant,
    observedLlmCalls: 0,
    engineLlmCalls: null,
    frames: [],
    status: "running",
    elapsedMs: null,
  };
  manifest.stages.push(stage);
  const started = performance.now();
  const server = await startServer({ port, variant, artifacts: output });
  const browser = new ChromeDevToolsDriver({
    args: [
      "-y",
      "chrome-devtools-mcp@1.8.0",
      "--isolated",
      "--no-page-id-routing",
      "--headless",
    ],
  });
  const events = [];
  const trace = { emit: (event) => events.push(event) };
  const llm = {
    id: client.id,
    async complete(prompt, options) {
      stage.observedLlmCalls++;
      if (["replay", "changed-without-heal", "repaired-replay"].includes(id))
        throw new Error("A deterministic replay attempted an LLM call");
      if (totalCalls >= maxCalls)
        throw new Error(`Demo stopped at its ${maxCalls}-call limit`);
      totalCalls++;
      console.log(`[${id}] LLM completion ${totalCalls}/${maxCalls}`);
      return client.complete(prompt, options);
    },
  };
  // Decorate the public Driver port to preserve actual browser frames after actions.
  // No screenshots, verdicts, or model responses are manufactured for the viewer.
  const driver = new Proxy(browser, {
    get(target, key) {
      const value = target[key];
      if (!mutationMethods.has(key))
        return typeof value === "function" ? value.bind(target) : value;
      return async (...args) => {
        let error;
        try {
          return await value.apply(target, args);
        } catch (caught) {
          error = caught.message;
          throw caught;
        } finally {
          const screenshot = await target.screenshot();
          const frame = { action: key, args, ...(error ? { error } : {}) };
          if (screenshot) {
            const match = /^data:image\/(png|jpeg);base64,(.*)$/s.exec(
              screenshot,
            );
            if (match) {
              const name = `${stage.frames.length}.${match[1] === "jpeg" ? "jpg" : "png"}`;
              await writeFile(
                resolve(folder, name),
                Buffer.from(match[2], "base64"),
              );
              frame.image = `${id}/${name}`;
            }
          }
          stage.frames.push(frame);
          console.log(`[${id}] ${key}${error ? ": failed" : ""}`);
        }
      };
    },
  });
  try {
    await work({ driver, llm, trace, stage, origin: server.origin });
    stage.oracle = server.snapshot();
    stage.status = "recorded";
  } catch (error) {
    stage.status = "error";
    stage.error = error.message;
    throw error;
  } finally {
    stage.elapsedMs = Math.round(performance.now() - started);
    stage.oracle ??= server.snapshot();
    stage.trace = `${id}/trace.json`;
    try {
      await json(stage.trace, events);
      await json("manifest.json", manifest);
    } finally {
      try {
        await browser.close();
      } finally {
        await server.close();
      }
    }
  }
  return stage;
}

async function replay(id, title, variant, scenario, heal) {
  let outcome;
  const stage = await recordStage(
    id,
    title,
    variant,
    async ({ driver, llm, trace, stage }) => {
      outcome = await runScenario(structuredClone(scenario), {
        driver,
        llm,
        trace,
        heal,
        maxSteps: 10,
        reporter: { async emit() {} },
      });
      stage.verdict = outcome.result.verdict;
      stage.engineLlmCalls = outcome.result.usage?.llmCalls ?? null;
      stage.heals = [...outcome.heals, ...outcome.stepHeals];
      stage.requests = outcome.result.evidence.logic.requests;
      stage.result = `${id}/result.json`;
      stage.scenario = `${id}/scenario.json`;
      stage.scenarioHash = hash(JSON.stringify(scenario));
      await saveSkillFile(resolve(output, stage.scenario), scenario);
      await json(stage.result, outcome);
      assert.equal(
        stage.engineLlmCalls,
        stage.observedLlmCalls,
        "Engine and host call counts disagree",
      );
    },
  );
  return { stage, outcome };
}

async function main() {
  assert.ok(
    Number.isInteger(maxCalls) && maxCalls > 0,
    "DEMO_MAX_CALLS must be a positive integer",
  );
  // Never overwrite a previous recording or silently mix runs.
  await mkdir(output);
  // Preserve the installed build before any execution. The downloadable example
  // must use these same bytes, even if the workspace is rebuilt afterwards.
  const engineRoot = dirname(dirname(fileURLToPath(import.meta.resolve("cairn-engine"))));
  const enginePackage = JSON.parse(await readFile(resolve(engineRoot, "package.json"), "utf8"));
  const packResult = JSON.parse(execFileSync("npm", [
    "pack", engineRoot, "--ignore-scripts", "--json", "--pack-destination", output,
  ], { encoding: "utf8" }));
  const packed = Array.isArray(packResult) ? packResult[0] : packResult[enginePackage.name];
  assert.ok(packed?.filename, "npm pack returned no engine archive");
  manifest.engine = {
    version: enginePackage.version,
    archive: packed.filename,
    sha256: hash(await readFile(resolve(output, packed.filename))),
  };
  const sourceFiles = [
    "record.mjs",
    "server.mjs",
    "public/shop/index.html",
    "public/shop/shop.js",
    "public/shop/shop.css",
  ];
  manifest.sourceHashes = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (path) => [
        path,
        hash(await readFile(resolve(directory, path))),
      ]),
    ),
  );
  let frozen;
  await recordStage(
    "discover",
    "Describe it once",
    "original",
    async ({ driver, llm, trace, stage, origin }) => {
      const discoveryTrace = startTrace(trace, ENGINE_VERSION).scope("discover");
      discoveryTrace.emit({
        kind: "case-start",
        payload: { id: "discover", intent, cached: false },
      });
      frozen = await discover(intent, {
        driver,
        llm,
        baseUrl: origin + "/shop/",
        trace: discoveryTrace,
        maxSteps: 10,
        semanticChecks: false,
      });
      assert.ok(!frozen.truncated, "Discovery did not finish");
      assert.ok(
        frozen.assertions.some(
          (a) =>
            a.kind === "request-status" &&
            a.method === "POST" &&
            a.status === 200 &&
            a.urlIncludes.includes("/api/order") &&
            !a.vacuous,
        ),
        "No grounded order proof; do not publish an arrival-only demo",
      );
      stage.scenario = "discover/scenario.json";
      stage.scenarioHash = hash(JSON.stringify(frozen));
      await saveSkillFile(resolve(output, stage.scenario), frozen);
      assert.deepEqual(
        await loadSkillFile(resolve(output, stage.scenario)),
        frozen,
      );
      discoveryTrace.emit({
        kind: "freeze",
        phase: "discover",
        payload: {
          ref: stage.scenario,
          assertions: {
            user: frozen.assertions.filter((a) => a.origin === "user").length,
            derived: frozen.assertions.filter((a) => a.origin === "derived").length,
            unknown: frozen.assertions.filter((a) => !a.origin).length,
          },
        },
      });
    },
  );
  const initial = await replay(
    "replay",
    "Replay without a model",
    "original",
    frozen,
    false,
  );
  assert.equal(initial.stage.verdict.passed, true);
  assert.equal(initial.stage.verdict.proof?.grade, "work");
  assert.equal(initial.stage.observedLlmCalls, 0);
  assert.equal(initial.stage.oracle.completed, true);
  const brokenTarget = await replay(
    "changed-without-heal",
    "Change the interface",
    "changed",
    frozen,
    false,
  );
  assert.equal(
    brokenTarget.stage.verdict.passed,
    false,
    "The UI change did not actually break this freeze",
  );
  assert.equal(brokenTarget.stage.observedLlmCalls, 0);
  const repaired = await replay(
    "heal",
    "Repair the saved test",
    "changed",
    frozen,
    true,
  );
  assert.equal(repaired.stage.verdict.passed, true);
  assert.ok(repaired.stage.observedLlmCalls > 0, "No measured model repair");
  assert.ok(repaired.outcome.healedScenario, "No verified repair to save");
  assert.deepEqual(
    repaired.outcome.healedScenario.assertions,
    frozen.assertions,
    "Repair changed the original goal",
  );
  assert.equal(repaired.stage.oracle.completed, true);
  await saveSkillFile(
    resolve(output, "repaired.skill.json"),
    repaired.outcome.healedScenario,
  );
  const healed = await loadSkillFile(resolve(output, "repaired.skill.json"));
  const again = await replay(
    "repaired-replay",
    "Keep the repair",
    "changed",
    healed,
    false,
  );
  assert.equal(again.stage.verdict.passed, true);
  assert.equal(again.stage.observedLlmCalls, 0);
  assert.equal(again.stage.oracle.completed, true);
  // Healing stays enabled here: a real API regression must remain red even if a repair is attempted.
  const defect = await replay(
    "bug",
    "Catch a real app defect",
    "broken",
    healed,
    true,
  );
  assert.equal(
    defect.stage.verdict.passed,
    false,
    "The engine hid an application defect",
  );
  assert.equal(defect.stage.oracle.completed, false);
  assert.ok(
    defect.stage.requests.some(
      (r) =>
        r.method === "POST" && r.url.includes("/api/order") && r.status === 500,
    ),
  );
  assert.ok(
    defect.stage.verdict.results.some(
      (r) =>
        !r.passed &&
        r.assertion.kind === "request-status" &&
        r.assertion.urlIncludes.includes("/api/order"),
    ),
  );
  assert.ok(
    !defect.outcome.healedScenario,
    "An invalid repair was offered for saving",
  );
  manifest.complete = true;
  manifest.totalCalls = totalCalls;
  await json("manifest.json", manifest);
  console.log(
    `Recording verified: ${output}; ${totalCalls} LLM calls. The final failing verdict is intentional.`,
  );
}

main().catch(async (error) => {
  manifest.error = error.message;
  manifest.totalCalls = totalCalls;
  try {
    if (manifest.stages.length) await json("manifest.json", manifest);
  } catch {
    /* Preserve the original error. */
  }
  console.error(error);
  process.exitCode = 1;
});
