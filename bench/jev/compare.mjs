/** Paired selection corpus. Default is an offline plumbing run; live needs an approved config.
 * No browser outcome is fabricated: actual repair success and false-pass metrics stay null. */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cases as syntheticCases } from "./corpus.mjs";
import { createBudget } from "../local/budget.mjs";
import { createLlm } from "../local/llm.mjs";
import { FakeDriver, SelfHealingDriver, JevTargetSelector, createTargetChoiceRepair } from "../../packages/harness/dist/index.js";

const live = process.argv.includes("--live");
const option = key => { const index = process.argv.indexOf(key); return index < 0 ? undefined : process.argv[index + 1]; };
const config = option("--config") ? JSON.parse(await readFile(option("--config"), "utf8")) : null;
const capture = option("--capture") ? JSON.parse(await readFile(option("--capture"), "utf8")) : null;
const cases = capture ? capture.observations.map(({ state, gold }, i) => ({ id: `230-captured-${i}`, split: "validation",
  original: state.original, elements: state.candidates.map(({ key, ...fields }) => ({ ref: key, ...fields })), gold })) : syntheticCases;
if (live && (!config?.approval || !process.env.TYPESAFE_API_KEY || !config?.baseline?.model ||
    !["claude-code", "codex"].includes(config?.baseline?.backend) || !Number.isFinite(config?.jev?.inputUsdPerMillion))) {
  throw new Error("Live evaluation requires documented approval, TYPESAFE_API_KEY, a hosted baseline model/backend, and current Jev pricing in --config");
}
const baselineBudget = live ? createBudget(config.baseline) : null;
const jevBudget = live ? createBudget(config.jev) : null;
const baseline = live ? createLlm({ source: "llm", ...config.baseline }, { budget: baselineBudget }) : null;
const jev = live ? new JevTargetSelector({ model: config.jev.model, timeoutMs: config.jev.timeoutMs }) : null;
const records = [];
const evidence = { execution: { actions: [], blocked: false, navigated: false }, perception: {}, logic: { requests: [], console: [] } };

for (const [index, row] of cases.entries()) {
  // Alternate order to reduce a systematic first-arm bias; each arm receives the same raw rows.
  for (const arm of index % 2 ? ["jev", "legacy"] : ["legacy", "jev"]) {
    if (live && (baselineBudget.snapshot().stopReason || jevBudget.snapshot().stopReason)) break;
    class SnapshotDriver extends FakeDriver {
      selected = null;
      async locateRef(ref) {
        const element = row.elements.find(e => e.ref === ref);
        if (!element) throw new Error("unknown ref");
        return { text: element.name, role: element.role, selector: `#${ref}` };
      }
      async click(target, ref) {
        if (target === row.original) throw Object.assign(new Error("stale target"), { kind: "resolution" });
        const selected = ref ?? row.elements.find(e => target.selector === `#${e.ref}` || target.text === e.name)?.ref;
        if (!selected) throw new Error("unknown target");
        this.selected = selected;
      }
    }
    const driver = new SnapshotDriver({ evidence, elements: row.elements });
    let decision, baselineReply;
    const references = new Map();
    const scripted = { id: "scripted-contract-only", async complete(prompt) {
      const candidate = row.gold && row.elements.find(e => e.ref === row.gold);
      const line = candidate && prompt.split("\n").find(line => line.includes('ref="') && line.includes(candidate.name));
      return line ? JSON.stringify({ ref: /ref="([^"]+)"/.exec(line)[1] }) : '{"name":null}';
    } };
    const llm = { id: baseline?.id ?? scripted.id, async complete(...args) { baselineReply = await (baseline ?? scripted).complete(...args); return baselineReply; } };
    const selector = { async select(request) {
      for (const candidate of request.candidates) {
        const peers = row.elements.filter(e => e.name === candidate.name && e.role === candidate.role);
        references.set(candidate.key, peers[candidate.nth ?? 0]?.ref);
      }
      if (live) {
        jevBudget.reserve();
        const result = await jev.select(request);
        jevBudget.record({ costUsd: result.usage ? result.usage.inputTokens * config.jev.inputUsdPerMillion / 1e6 : result.requested ? null : 0,
          error: result.error ?? null, modelIds: result.model ? [result.model] : [] });
        return result;
      }
      const key = row.gold === null ? "none" : [...references].find(([, ref]) => ref === row.gold)[0];
      return { provider: "scripted", requestedModel: "contract-only", questionVersion: "contract-only", candidateSetId: row.id,
        requested: false, latencyMs: 0, answer: { choice: key, confidence: 1,
          probabilities: Object.fromEntries([...request.candidates.map(c => c.key), "none"].map(k => [k, k === key ? 1 : 0])) } };
    } };
    // null is the live default: selection is observable but never dispatches without a chosen threshold.
    const minConfidence = live ? config.jev.minConfidence ?? null : 0.7;
    const healer = new SelfHealingDriver(driver, llm, arm === "jev" ? { choice: createTargetChoiceRepair({ selector, minConfidence,
      context: () => ({ intent: row.original.text, stepRef: 0 }), onDecision: result => { decision = result; } }) } : {});
    const start = performance.now(); let failed = false;
    try { await healer.click(row.original); } catch { failed = true; }
    const selected = arm === "jev" ? references.get(decision?.answer?.choice) ?? null : driver.selected;
    const answerNone = arm === "jev" ? decision?.answer?.choice === "none" : baselineReply === '{"name":null}' || /"name"\s*:\s*null/.test(baselineReply ?? "");
    records.push({ case: row.id, split: row.split, arm, inputHash: createHash("sha256").update(JSON.stringify(row)).digest("hex"),
      clientCondition: index === 0 ? "first-call" : "reused-client", providerCache: "unknown", gold: row.gold,
      selected, choiceCorrect: selected ? selected === row.gold : answerNone ? row.gold === null : null,
      abstained: driver.selected === null, dispatched: driver.selected, wrongSelection: selected !== null && selected !== row.gold, failed,
      fallback: false, latencyMs: performance.now() - start, decision,
      actualRepairSuccess: null, falsePass: null });
  }
}
const metrics = Object.fromEntries(["legacy", "jev"].map(arm => {
  const rows = records.filter(r => r.arm === arm); const n = rows.length;
  return [arm, { n, selectionAccuracy: n ? rows.filter(r => r.choiceCorrect === true).length / n : null,
    unknownSelection: rows.filter(r => r.choiceCorrect === null).length,
    wrongRepairRate: n ? rows.filter(r => r.dispatched !== null && r.dispatched !== r.gold).length / n : null,
    abstentionRate: n ? rows.filter(r => r.abstained).length / n : null, fallbackFrequency: 0,
    actualRepairSuccessRate: null, falsePassRate: null }];
}));
const report = { mode: live ? "live-selection-only" : "offline-contract-only", sampleCount: records.length, incomplete: records.length !== cases.length * 2, metrics,
  note: "No p50/p95 for this small pilot. No browser outcome, calibration, or model-quality claim from mock data. Inspect individual paired records.",
  records, baselineBudget: baselineBudget?.snapshot(), jevBudget: jevBudget?.snapshot() };
const output = option("--out");
if (output) await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
else console.log(JSON.stringify(report, null, 2));
