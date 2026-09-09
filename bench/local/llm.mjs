import { execFile } from "node:child_process";

export function createClaudeClient(config, { budget, signal, command = "claude" }) {
  return {
    id: `claude-code:${config.model}`,
    async complete(prompt, options = {}) {
      budget.reserve();
      const remaining = config.maxCostUsd - budget.snapshot().measuredCostUsd;
      let recorded = false;
      try {
        const { error, stdout } = await new Promise((resolve) => {
          const child = execFile(command, ["-p", "--output-format", "json", "--model", config.model, "--max-budget-usd", String(remaining), "--tools", "", "--no-session-persistence", "--safe-mode", ...(options.system ? ["--system-prompt", options.system] : [])], { signal, timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve({ error, stdout }));
          child.stdin.on("error", () => {});
          child.stdin.end(prompt);
        });
        let response;
        try { response = JSON.parse(stdout); } catch { throw new Error("Claude returned no valid JSON result", { cause: error }); }
        const failure = error || response.is_error || typeof response.result !== "string";
        budget.record({ costUsd: response.total_cost_usd, error: failure ? String(error?.message ?? response.result ?? "Claude completion failed") : null });
        recorded = true;
        const usage = response.usage;
        if (usage && [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens].some((value) => Number.isFinite(value) && value >= 0)) {
          const measured = {};
          for (const [from, to] of [["input_tokens", "inputTokens"], ["output_tokens", "outputTokens"], ["cache_read_input_tokens", "cacheReadTokens"]]) if (Number.isFinite(usage[from]) && usage[from] >= 0) measured[to] = usage[from];
          options.onUsage?.(measured);
        }
        if (failure) throw new Error(`Claude completion failed: ${error?.message ?? response.result ?? "invalid result"}`);
        return response.result;
      } catch (error) {
        if (!recorded) budget.record({ costUsd: null, error: String(error.message ?? error) });
        throw error;
      }
    },
  };
}

export function createScriptedClient(config, { tier, version, origin }) {
  const v2 = version === "v2";
  const action = (kind, text, role, extra = {}) => ({ action: kind, text, role, reason: "Local fixture smoke", ...extra });
  const wait = (text) => ({ action: "waitFor", until: { text }, reason: "Wait for the fixture outcome" });
  const actions = tier === "navigation" ? [action("click", v2 ? "Proceed" : "Continue", "link"), wait("Destination reached")] : tier === "form" ? [action("type", v2 ? "Display name" : "Name", "textbox", { value: "alice" }), action("click", v2 ? "Store" : "Save", "button"), wait("Saved")] : [action("type", v2 ? "Account" : "Username", "textbox", { value: "alice" }), action("click", v2 ? "Sign in" : "Log in", "button"), wait(v2 ? "Add item" : "Add to cart"), action("click", v2 ? "Add item" : "Add to cart", "button"), wait("Added"), action("click", "Cart", "link"), action("click", v2 ? "Confirm order" : "Place order", "button"), wait("Order complete")];
  const assertions = tier === "navigation" ? [{ kind: "navigated", to: `${origin}/done` }] : tier === "form" ? [{ kind: "request-status", urlIncludes: "/api/save", method: "POST", status: 200 }] : [{ kind: "request-status", urlIncludes: "/api/order", method: "POST", status: 200 }, { kind: "navigated", to: `${origin}/done` }];
  actions.push({ action: "done", reason: "Fixture completed", assertions });
  let cursor = 0;
  return { id: `scripted:${config.label}`, async complete(_prompt, options = {}) {
    if (options.system?.startsWith("You propose verification assertions")) return JSON.stringify(assertions);
    if (!options.system?.startsWith("You are a QA agent driving a web browser")) throw new Error("Scripted smoke does not simulate LLM repair decisions");
    if (!actions[cursor]) throw new Error("Scripted fixture decisions exhausted");
    return JSON.stringify(actions[cursor++]);
  } };
}

export function createLlm(config, context) {
  if (config.source === "scripted") return createScriptedClient(config, context);
  if (config.backend !== "claude-code") throw new Error("Only the explicit claude-code paid backend is supported");
  return createClaudeClient(config, context);
}
