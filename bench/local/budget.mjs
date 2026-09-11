export function createBudget({ maxCalls, maxCostUsd, budgetMode }) {
  const callsOnly = budgetMode === "calls";
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || (budgetMode !== undefined && !callsOnly) || (callsOnly ? maxCostUsd !== undefined : !Number.isFinite(maxCostUsd) || maxCostUsd <= 0)) throw new Error("Invalid LLM budget");
  let calls = 0, measuredCostUsd = 0, costComplete = true, pending = false;
  const records = [];
  const stopReason = () => pending || (!callsOnly && !costComplete) ? "LLM cost is unknown" : calls >= maxCalls ? "LLM call limit reached" : !callsOnly && measuredCostUsd >= maxCostUsd ? "Measured cost threshold reached" : null;
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
      records.push({ costUsd: known ? value.costUsd : null, error: value?.error ?? null, ...(Array.isArray(value?.modelIds) ? { modelIds: [...value.modelIds] } : {}), ...(value?.models ? { models: structuredClone(value.models) } : {}), ...(value?.providerDiagnostics ? { providerDiagnostics: structuredClone(value.providerDiagnostics) } : {}), ...(value?.providerSubtype != null ? { providerSubtype: value.providerSubtype } : {}) });
    },
    snapshot() { return { calls, measuredCostUsd, costComplete: costComplete && !pending, stopReason: stopReason(), records: structuredClone(records) }; },
  };
}
