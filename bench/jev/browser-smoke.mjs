/** Real Chrome + #230's existing fixture; scripted HTTP answers, never a paid model evaluation. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { startFixture, fixtureInfo, reservePort } from "../local/server.mjs";
import { ChromeDevToolsDriver, JevTargetSelector, runScenario } from "../../packages/harness/dist/index.js";

const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const fixtureOptions = { tier: "stateful", version: "v3", runIndex: 0, latency: { document: [0], api: [0] }, port };
const mcp = process.env.CAIRN_MCP_ENTRY;
const flags = ["--isolated", "--headless", "--no-page-id-routing", "--no-usage-statistics"];
const preserveNetwork = process.argv.includes("--preserve-network");
const cumulativeNetwork = process.argv.includes("--cumulative-network");
const driver = () => {
  const browser = new ChromeDevToolsDriver({ ...(mcp ? { command: process.execPath, args: [mcp, ...flags] }
    : { command: "npx", args: ["-y", "chrome-devtools-mcp@1.8.0", ...flags] }), timeoutMs: 20000, connectTimeoutMs: 30000 });
  // Diagnostic experiment only. The default driver currently requests only the latest page's
  // network log. MCP exposes preserved requests across three navigations; keep assertions fixed.
  if (preserveNetwork || cumulativeNetwork) {
    const call = browser.call.bind(browser);
    const requests = new Map();
    browser.call = async (name, args, purpose) => {
      const response = await call(name, name === "list_network_requests" ? { ...args, includePreservedRequests: true } : args, purpose);
      if (name !== "list_network_requests" || !cumulativeNetwork) return response;
      // The Step expect watermark requires an append-only log, whereas MCP's preserved window
      // still evicts old navigations. This diagnostic shim keys the real wire rows by reqid.
      for (const line of response.split("\n")) {
        const match = /^reqid=(\d+)\s/.exec(line);
        if (match) requests.set(match[1], line);
      }
      return [...requests.values()].join("\n");
    };
  }
  return browser;
};
const scenario = {
  name: "230 order target repair", steps: [
    { kind: "goto", url: `${origin}/login` },
    { kind: "type", target: { text: "Username", role: "textbox" }, text: "alice" },
    { kind: "click", target: { text: "Log in", role: "button" }, expect: { url: "/products" } },
    { kind: "click", target: { text: "Add to cart", role: "button" }, expect: { requestStatus: { urlIncludes: "/api/cart", method: "POST", status: 200 } } },
    { kind: "click", target: { text: "Cart", role: "link" }, expect: { url: "/cart" } },
    { kind: "click", target: { text: "Place order", role: "button", index: 0 }, intent: "Place the one-book order",
      expect: { requestStatus: { urlIncludes: "/api/order", method: "POST", status: 200 } } },
    { kind: "waitFor", until: { url: "/done" } },
  ], assertions: [{ kind: "request-status", urlIncludes: "/api/order", method: "POST", status: 200, origin: "user" },
    { kind: "navigated", to: `${origin}/done`, origin: "user" }],
};
let calls = 0;
const observations = [];
const selector = new JevTargetSelector({ apiKey: "scripted-no-network", fetch: async (_url, init) => {
  calls++;
  const body = JSON.parse(init.body);
  const selected = body.state.candidates.find(c => c.name === "Place order" && c.role === "link");
  assert.ok(selected, "actual perception must contain #230's v3 order link");
  observations.push({ state: body.state, gold: selected.key });
  return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { target: { type: "choice", choice: selected.key, confidence: 1,
    probabilities: Object.fromEntries(Object.keys(body.questions.target.criteria).map(key => [key, key === selected.key ? 1 : 0])) } },
    usage: { input_tokens: 0, output_tokens: 0 } }));
} });
const report = { mode: "real-browser-scripted-HTTP", preserveNetwork, cumulativeNetwork, observations, fixture: fixtureInfo("stateful", "v3"), records: [] };
let replay = scenario;
for (const phase of ["repair", "replay"]) {
  const server = await startFixture(fixtureOptions); const browser = driver();
  const beforeCalls = calls; const events = []; const started = performance.now();
  try {
    const result = await runScenario(replay, { driver: browser, targetChoice: { selector, minConfidence: 0.7 }, expectTimeoutMs: 5000,
      llm: { id: "forbidden", complete: async () => { throw new Error("unexpected LLM fallback"); } },
      reporter: { emit: async () => {} }, trace: { emit: event => events.push(event) } });
    report.records.push({ phase, browserCondition: "fresh-isolated-browser", fixtureCondition: "fresh-session", elapsedMs: performance.now() - started,
      calls: calls - beforeCalls, outcome: server.snapshot(), verdict: result.result.verdict, healedScenarioAvailable: Boolean(result.healedScenario), events });
    if (!result.result.verdict.passed) { process.exitCode = 1; break; }
    assert.equal(server.snapshot().orderCount, 1); assert.equal(server.snapshot().complete, true);
    assert.equal(calls - beforeCalls, phase === "repair" ? 1 : 0);
    if (phase === "repair") { assert.ok(result.healedScenario); replay = result.healedScenario; }
  } finally { await browser.close(); await server.close(); }
}
const output = process.argv[2];
if (output) await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ mode: report.mode, records: report.records.map(({ phase, calls, outcome, elapsedMs }) => ({ phase, calls, outcome, elapsedMs })) }, null, 2));
