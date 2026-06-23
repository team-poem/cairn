// UI-churn benchmark — the report's unanswered question: when the UI CHANGES, does a frozen
// scenario break (model-③'s 48% trap) and does self-heal actually recover it, at what cost?
//
// Serves two versions of the same flow on localhost: v1 (discover here) and v2 (UI renamed).
// Then replays the v1-frozen scenario against v2, with and without self-heal.

import { createServer } from "node:http";
import { discover, ChromeDevToolsDriver, createLlmClient, runScenario } from "/Users/deliveredkorea/cairn/packages/harness/dist/index.js";

const V1 = `<!doctype html><html lang=en><meta charset=utf8><body>
  <input aria-label="Username">
  <button>Log in</button>
  <div id=r></div>
  <script>document.querySelector('button').onclick=()=>{const v=document.querySelector('input').value;document.getElementById('r').textContent=v?('Welcome '+v):'error'}</script>
</body></html>`;
// v2: same flow, UI renamed so the old accessible names no longer match (a real UI change).
const V2 = V1.replace('aria-label="Username"', 'aria-label="Account"').replace(">Log in<", ">Sign in<");

const PORT = 8077;
const base = `http://localhost:${PORT}`;
const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(req.url.startsWith("/v2") ? V2 : V1);
});
await new Promise((r) => server.listen(PORT, r));

function countingLlm(inner) {
  const s = { calls: 0 };
  return { id: inner.id, _s: s, async complete(p, o) { s.calls++; return inner.complete(p, o); } };
}
const stepStr = (s) => s.kind + (s.target?.text ? `("${s.target.text}")` : s.url ? "(url)" : "");

try {
  // 1. discover the flow on v1
  const driver = new ChromeDevToolsDriver();
  const llm = countingLlm(createLlmClient({ model: "sonnet" }));
  let scenario;
  try {
    scenario = await discover("Type 'alice' into the username field, then click the log in button", {
      driver, llm, baseUrl: `${base}/v1`, maxSteps: 6,
    });
  } finally {
    await driver.close();
  }
  console.log(`\ndiscovered on v1:  ${scenario.steps.map(stepStr).join(" → ")}   · ${llm._s.calls} LLM turns`);

  // point the same frozen steps at the CHANGED page (v2)
  const churned = { ...scenario, steps: scenario.steps.map((s) => (s.kind === "goto" ? { ...s, url: `${base}/v2` } : s)) };

  const M = 4;

  // 2. replay frozen-v1 on v2 WITHOUT heal — does the UI change break it?
  let broke = 0;
  for (let i = 0; i < M; i++) {
    const { result } = await runScenario(churned, {});
    if (result.evidence.execution.blocked) broke++;
  }
  console.log(`\nv2, NO heal:    broke ${broke}/${M}   → frozen scenario survives UI change? ${broke === 0 ? "YES" : "NO (inherits the brittleness)"}`);

  // 3. replay frozen-v1 on v2 WITH heal — does self-heal recover, and at what cost?
  let recovered = 0, totalHeals = 0, totalHealTurns = 0;
  for (let i = 0; i < M; i++) {
    const hllm = countingLlm(createLlmClient({ model: "haiku" }));
    const { result, heals } = await runScenario(churned, { heal: true, llm: hllm });
    if (!result.evidence.execution.blocked && result.verdict.passed) recovered++;
    totalHeals += heals.length;
    totalHealTurns += hllm._s.calls;
  }
  console.log(`v2, WITH heal:  recovered ${recovered}/${M}   · avg ${(totalHeals / M).toFixed(1)} heals/run · ${(totalHealTurns / M).toFixed(1)} LLM calls/run`);
  console.log(`\n→ the report's missing numbers: brittleness under change AND whether self-heal earns its cost.`);
} finally {
  server.close();
}
