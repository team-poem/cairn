// cairn benchmark harness — turns the report's open questions into numbers.
// Measures: discover cost (LLM turns · prompt volume · wall-clock) and, crucially,
// REPLAY FLAKINESS over M runs on a real multi-step flow (does invariant #4 hold off toy sites?).
//
// Phase 1:  node benchmark.mjs discover   → discover each flow, freeze to bench/frozen/<id>.json, print discover cost
// Phase 2:  node benchmark.mjs replay     → replay each frozen flow M times, print pass-rate / flakiness
//
// Split into two phases so neither invocation risks the shell timeout.

import { discover, ChromeDevToolsDriver, createLlmClient, runScenario } from "/Users/deliveredkorea/cairn/packages/harness/dist/index.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";

const FROZEN_DIR = "/Users/deliveredkorea/cairn/bench/frozen";

const FLOWS = [
  {
    id: "saucedemo-checkout",
    url: "https://www.saucedemo.com",
    intent:
      "Log in with username 'standard_user' and password 'secret_sauce', then add the first product to the cart, then open the shopping cart page.",
    model: "sonnet",
    maxSteps: 14,
    replays: 4,
  },
  {
    id: "todomvc-add",
    url: "https://todomvc.com/examples/react/dist/",
    intent: "Add a new todo item with the text 'buy milk', then mark it as completed.",
    model: "sonnet",
    maxSteps: 10,
    replays: 4,
  },
];

const sec = (t) => `${(t / 1000).toFixed(1)}s`;
const stepStr = (s) =>
  s.kind + (s.target?.text ? `("${s.target.text}")` : s.url ? `(${s.url})` : s.key ? `(${s.key})` : s.value ? `="${s.value}"` : "");

// Counts LLM turns + prompt volume during discover (the article: cost ∝ turns · context growth).
function countingLlm(inner) {
  const stats = { calls: 0, promptChars: 0 };
  return {
    id: inner.id,
    _stats: stats,
    async complete(prompt, opts) {
      stats.calls++;
      stats.promptChars += prompt.length + (opts?.system?.length ?? 0);
      return inner.complete(prompt, opts);
    },
  };
}

async function phaseDiscover() {
  mkdirSync(FROZEN_DIR, { recursive: true });
  for (const flow of FLOWS) {
    console.log(`\n=== DISCOVER · ${flow.id} ===`);
    const driver = new ChromeDevToolsDriver();
    const llm = countingLlm(createLlmClient({ model: flow.model }));
    const t0 = Date.now();
    let scenario, err;
    try {
      scenario = await discover(flow.intent, { driver, llm, baseUrl: flow.url, maxSteps: flow.maxSteps });
    } catch (e) {
      err = e;
    } finally {
      await driver.close();
    }
    const took = Date.now() - t0;
    if (err) {
      console.log(`  ❌ discover failed: ${err.message}`);
      continue;
    }
    writeFileSync(`${FROZEN_DIR}/${flow.id}.json`, JSON.stringify({ flow, scenario }, null, 2));
    console.log(`  steps:   ${scenario.steps.length}  →  ${scenario.steps.map(stepStr).join(" → ")}`);
    console.log(`  cost:    ${llm._stats.calls} LLM turns · ${Math.round(llm._stats.promptChars / 1000)}K prompt chars · ${sec(took)}`);
    console.log(`  frozen → bench/frozen/${flow.id}.json`);
  }
}

async function phaseReplay() {
  // Two distinct numbers: JOURNEY = did every step replay (the report's real flakiness
  // question); VERDICT = did the (possibly imperfect) assertions also hold.
  console.log(`\n${"flow".padEnd(22)} journey   verdict   deterministic?   avg/run   (LLM=0)`);
  for (const flow of FLOWS) {
    const path = `${FROZEN_DIR}/${flow.id}.json`;
    if (!existsSync(path)) {
      console.log(`  ${flow.id}: (no frozen scenario — run discover first)`);
      continue;
    }
    const { scenario } = JSON.parse(readFileSync(path, "utf8"));
    let journeyOk = 0;
    let verdictPass = 0;
    const times = [];
    for (let i = 0; i < flow.replays; i++) {
      const r0 = Date.now();
      try {
        const { result } = await runScenario(scenario, {});
        const journey = !result.evidence.execution.blocked; // every step executed
        if (journey) journeyOk++;
        if (journey && result.verdict.passed) verdictPass++;
      } catch {
        /* counts as a journey failure */
      }
      times.push(Date.now() - r0);
    }
    const M = flow.replays;
    const deterministic = journeyOk === 0 || journeyOk === M ? "yes" : "FLAKY";
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(
      `  ${flow.id.padEnd(22)} ${`${journeyOk}/${M}`.padStart(5)}    ${`${verdictPass}/${M}`.padStart(5)}    ${deterministic.padStart(11)}     ${sec(avg).padStart(8)}`,
    );
  }
  console.log(`\njourney = all steps replayed (the determinism the report doubted) · verdict = assertions also held`);
}

const phase = process.argv[2];
if (phase === "discover") await phaseDiscover();
else if (phase === "replay") await phaseReplay();
else console.error("usage: node benchmark.mjs <discover|replay>");
