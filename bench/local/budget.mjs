export function createBudget({ maxCalls, maxCostUsd }) {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0) throw new Error("Invalid LLM budget");
  let calls = 0, measuredCostUsd = 0, costComplete = true, pending = false;
  const records = [];
  const stopReason = () => !costComplete || pending ? "LLM cost is unknown" : calls >= maxCalls ? "LLM call limit reached" : measuredCostUsd >= maxCostUsd ? "Measured cost threshold reached" : null;
  return {
    reserve() {
      const reason = stopReason();
      if (reason) throw new Error(reason);
      calls++; pending = true;
    },
    record(value) {
      if (!pending) throw new Error("No pending LLM call to record");
      pending = false;
      const known = Number.isFinite(value?.costUsd) && value.costUsd >= 0;
      if (known) measuredCostUsd += value.costUsd;
      else costComplete = false;
      records.push({ costUsd: known ? value.costUsd : null, error: value?.error ?? null });
    },
    snapshot() { return { calls, measuredCostUsd, costComplete: costComplete && !pending, stopReason: stopReason(), records: structuredClone(records) }; },
  };
}
