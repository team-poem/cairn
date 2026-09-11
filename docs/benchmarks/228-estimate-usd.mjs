// Reproduce this publication's estimates from its immutable observations and dated rate snapshot.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const input = await readFile(new URL("./228-codex.json", import.meta.url));
const rateBytes = await readFile(new URL("./228-openai-prices.json", import.meta.url));
const observations = JSON.parse(input);
const prices = JSON.parse(rateBytes);
const fields = ["inputTokens", "cacheReadTokens", "cacheCreationTokens", "outputTokens"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const dollars = (nanos) => `${nanos / 1000000000n}.${String(nanos % 1000000000n).padStart(9, "0")}`;

const estimates = observations.measurements.map((measurement) => {
  const model = measurement.configuration.llm.model;
  const rates = prices.models[model].usdPerMillionTokens;
  // These dated rates are exact integer nanodollars per token; accumulate without float rounding.
  const perToken = Object.fromEntries(fields.map((field) => {
    const nanos = rates[field] * 1000;
    assert(Number.isSafeInteger(nanos) && nanos >= 0, `Unsupported rate precision: ${model}/${field}`);
    return [field, BigInt(nanos)];
  }));
  for (const record of measurement.records) {
    assert(record.usageComplete, "Cannot price incomplete usage");
    for (const field of fields) assert(Number.isSafeInteger(record.observedUsage[field]) && record.observedUsage[field] >= 0);
  }
  // The entire run's input bounds each constituent request, including any CLI-internal work.
  const maxRunInputTokens = Math.max(...measurement.records.map(({ observedUsage: usage }) => fields.slice(0, 3).reduce((sum, field) => sum + usage[field], 0)));
  assert(maxRunInputTokens <= prices.shortContextInputLimit, "Cannot establish short-context pricing from these run totals");
  const summarize = (records) => {
    const usage = Object.fromEntries(fields.map((field) => [field, records.reduce((sum, record) => sum + record.observedUsage[field], 0)]));
    const nanos = fields.reduce((sum, field) => sum + BigInt(usage[field]) * perToken[field], 0n);
    return { calls: records.reduce((sum, record) => sum + record.observedUsage.llmCalls, 0), usage, estimatedCostUsd: dollars(nanos) };
  };
  return {
    model, maxRunInputTokens,
    tiers: measurement.configuration.tiers.map((tier) => ({ tier, ...Object.fromEntries(["agent", "cairn"].map((arm) => [arm, summarize(measurement.records.filter((record) => record.tier === tier && record.arm === arm))])) })),
    totals: Object.fromEntries(["agent", "cairn"].map((arm) => [arm, summarize(measurement.records.filter((record) => record.arm === arm))])),
  };
});

await writeFile(new URL("./228-codex-usd.json", import.meta.url), JSON.stringify({
  basis: prices.basis, checkedOn: prices.checkedOn, pricingSource: prices.source,
  observationsSha256: sha256(input), priceSnapshotSha256: sha256(rateBytes),
  formula: "sum(disjoint reported token count * matching USD-per-million rate) / 1000000",
  note: "Derived estimates only. The source report's unknown cost, comparability flags and token counts are unchanged.",
  estimates,
}, null, 2) + "\n");
