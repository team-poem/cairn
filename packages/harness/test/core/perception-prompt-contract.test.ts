// file: packages/harness/test/core/perception-prompt-contract.test.ts
import { expect, it } from "vitest";
import { PerceptionObservation } from "../../src/core/observation.js";
import { applyDecision, parseDecision } from "../../src/core/discover/decision.js";
import { discover } from "../../src/core/discover/index.js";
import { SYSTEM, ACTION_VOCABULARY, ACTION_RULES, PERCEPTION_RULES } from "../../src/core/discover/prompt.js";
import { LlmStepHealer } from "../../src/core/step-heal.js";
import { explore } from "../../src/core/explore/index.js";
import { EXPLORE_SYSTEM } from "../../src/core/explore/prompt.js";
import type { LlmClient, PerceptionAdapter } from "../../src/core/ports.js";
import type { PageElement, Target } from "../../src/core/types.js";
import { StubDriver } from "../support/doubles.js";

class PromptRefDriver extends StubDriver {
  readonly exact: string[] = [];
  constructor(rows: PageElement[] = [{ role: "button", name: "Save", ref: "node-save" }]) {
    super();
    this.els = rows;
  }
  async locateRef(ref: string): Promise<Target> {
    const row = this.els.find(e => e.ref === ref);
    if (!row) throw new Error("unknown driver ref");
    return { text: row.name, role: row.role, selector: `#${ref}` };
  }
  override async click(_target: Target, ref?: string): Promise<void> {
    if (!ref) throw new Error("unexpected legacy fallback");
    this.exact.push(ref);
  }
}
function promptRef(text: string): string {
  const ref = text.match(/ref="([^"]+)"/)?.[1];
  if (!ref) throw new Error("missing observation ref in prompt");
  return ref;
}
class PromptRecordingLlm implements LlmClient {
  readonly id = "phase2-scripted";
  readonly prompts: string[] = [];
  readonly systems: string[] = [];
  constructor(private readonly reply: (prompt: string, turn: number) => string = () => '{"action":"done"}') {}
  async complete(prompt: string, opts?: Parameters<LlmClient["complete"]>[1]): Promise<string> {
    if (!prompt.includes("What is the single next action?")) return "[]";
    this.prompts.push(prompt);
    this.systems.push(opts?.system ?? "");
    return this.reply(prompt, this.prompts.length);
  }
}
async function runPromptLoop(mode: "discover" | "explore", driver: PromptRefDriver, llm: LlmClient, perceive?: PerceptionAdapter) {
  const opts = { driver, llm, perceive, baseUrl: "https://app/start", maxSteps: 4 };
  return mode === "discover" ? discover("save", opts) : explore("save", opts);
}

it("normalizedPerceivePreservesCanonicalRef: trimming a label preserves exact driver identity and raw persistent description", async () => {
  for (const mode of ["discover", "explore"] as const) {
    const driver = new PromptRefDriver([{ role: "button", name: "  Save  ", ref: "node-save" }]);
    const llm = new PromptRecordingLlm((prompt, turn) => turn === 1
      ? JSON.stringify({ action: "click", ref: promptRef(prompt), text: "save" })
      : '{"action":"done"}');
    const result = await runPromptLoop(mode, driver, llm, rows => rows.map(row => ({ ...row, name: row.name.trim() })));
    expect(result.truncated).not.toBe(true);
    expect(driver.exact).toEqual(["node-save"]);
    expect(result.steps.find(step => step.kind === "click")).toMatchObject({ target: { text: "  Save  ", role: "button", selector: "#node-save" } });
    expect(driver.els[0]?.name).toBe("  Save  ");
  }
});
