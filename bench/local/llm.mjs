import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One CLI call can bill more than one model: the tool runs a small helper model of its own beside
 * the model under test. `costBasis` says how the provider priced it, and "list" means API list
 * price, which is what makes a subscription run comparable to what an API caller would have paid.
 * Reporting the split keeps a per-model number from quietly including the helper's share.
 */
function perModel(modelUsage) {
  if (!modelUsage || typeof modelUsage !== "object") return null;
  const fields = [["inputTokens", "inputTokens"], ["outputTokens", "outputTokens"], ["cacheReadInputTokens", "cacheReadTokens"], ["cacheCreationInputTokens", "cacheCreationTokens"]];
  const out = {};
  for (const [id, usage] of Object.entries(modelUsage)) {
    if (!usage || typeof usage !== "object") continue;
    const entry = { costUsd: Number.isFinite(usage.costUSD) && usage.costUSD >= 0 ? usage.costUSD : null, costBasis: typeof usage.costBasis === "string" ? usage.costBasis : null };
    for (const [from, to] of fields) if (Number.isFinite(usage[from]) && usage[from] >= 0) entry[to] = usage[from];
    out[id] = entry;
  }
  return Object.keys(out).length ? out : null;
}

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
        budget.record({ costUsd: response.total_cost_usd, modelIds: Object.keys(response.modelUsage ?? {}), models: perModel(response.modelUsage), providerSubtype: response.subtype ?? null, error: failure ? String(error?.message ?? response.result ?? "Claude completion failed") : null });
        recorded = true;
        const usage = response.usage;
        // Cache-CREATION tokens are billed and were being dropped, so a token total could not be
        // reconciled against `total_cost_usd` (#214). The engine's own RunUsage has no field for
        // them; this is the bench's own accounting, which is what the cost arms compare.
        const fields = [["input_tokens", "inputTokens"], ["output_tokens", "outputTokens"], ["cache_read_input_tokens", "cacheReadTokens"], ["cache_creation_input_tokens", "cacheCreationTokens"]];
        if (usage && fields.some(([from]) => Number.isFinite(usage[from]) && usage[from] >= 0)) {
          const measured = {};
          for (const [from, to] of fields) if (Number.isFinite(usage[from]) && usage[from] >= 0) measured[to] = usage[from];
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

/** Codex reports tokens, not dollars. Unknown money remains unknown in the shared ledger. */
export function createCodexClient(config, { budget, signal, command = "codex" }) {
  return {
    id: `codex:${config.model}`,
    async complete(prompt, options = {}) {
      budget.reserve();
      let directory, recorded = false;
      try {
        directory = await mkdtemp(join(tmpdir(), "cairn-bench-codex-"));
        const args = ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "--color", "never", "-m", config.model, "-c", "features.shell_tool=false", "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0", ...(config.reasoningEffort ? ["-c", `model_reasoning_effort="${config.reasoningEffort}"`] : []), "-"];
        const { error, stdout } = await new Promise((resolve) => {
          const child = execFile(command, args, { cwd: directory, signal, timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve({ error, stdout }));
          child.stdin.on("error", () => {});
          child.stdin.end(options.system ? `<system>\n${options.system}\n</system>\n\n${prompt}` : prompt);
        });
        const events = stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
        const completed = events.filter((event) => event.type === "turn.completed");
        const messages = events.filter((event) => event.type === "item.completed" && event.item?.type === "agent_message");
        const failed = events.find((event) => event.type === "turn.failed");
        const diagnostics = events.filter((event) => event.type === "error").map((event) => event.message);
        const rerouted = events.find((event) => event.type === "item.completed" && event.item?.type === "error" && event.item.message?.startsWith("model rerouted:"));
        const answer = messages.at(-1)?.item.text;
        const failure = error || failed || rerouted || completed.length !== 1 || typeof answer !== "string" || !answer.trim();
        const detail = String(error?.message ?? failed?.error?.message ?? rerouted?.item.message ?? diagnostics.at(-1) ?? "Codex returned no completed answer");
        budget.record({ costUsd: null, ...(diagnostics.length ? { providerDiagnostics: diagnostics } : {}), ...(failed ? { providerSubtype: failed.type } : {}), error: failure ? detail : null });
        recorded = true;
        const usage = completed.length === 1 ? completed[0].usage : null;
        if (usage && typeof usage === "object") {
          const valid = (key) => Number.isFinite(usage[key]) && usage[key] >= 0;
          const measured = {};
          // Codex input includes cache reads and writes; the benchmark's fields are disjoint.
          if (valid("input_tokens") && valid("cached_input_tokens") && valid("cache_write_input_tokens") && usage.cached_input_tokens + usage.cache_write_input_tokens <= usage.input_tokens) measured.inputTokens = usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens;
          if (valid("cached_input_tokens")) measured.cacheReadTokens = usage.cached_input_tokens;
          if (valid("cache_write_input_tokens")) measured.cacheCreationTokens = usage.cache_write_input_tokens;
          if (valid("output_tokens")) measured.outputTokens = usage.output_tokens;
          options.onUsage?.(measured);
        }
        if (failure) throw new Error(`Codex completion failed: ${detail}`);
        return answer;
      } catch (error) {
        if (!recorded) budget.record({ costUsd: null, error: String(error.message ?? error) });
        throw error;
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

export function createLlm(config, context) {
  if (config.source === "scripted") return createScriptedClient(config, context);
  if (config.backend === "codex") return createCodexClient(config, context);
  if (config.backend !== "claude-code") throw new Error("Only the explicit claude-code paid backend is supported");
  return createClaudeClient(config, context);
}
