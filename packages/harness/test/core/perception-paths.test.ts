import { it, expect } from "vitest";
import { StubDriver } from "../support/doubles.js";
import type { PageElement, SnapshotOptions, Step, Target } from "../../src/core/types.js";
import type { LlmClient } from "../../src/core/ports.js";
import { discover } from "../../src/core/discover/index.js";
import { explore } from "../../src/core/explore/index.js";
import { LlmStepHealer } from "../../src/core/step-heal.js";
import { SelfHealingDriver } from "../../src/adapters/drivers/self-heal.js";

class ExactDriver extends StubDriver {
  generation = 0;
  refs: string[] = [];
  override async snapshot(options?: SnapshotOptions): Promise<PageElement[]> {
    this.generation++;
    return [{ role: "button", name: "Delete", ...(options?.perception ? { ref: `driver:${this.generation}` } : {}) }];
  }
  async locateRef(ref: string): Promise<Target> {
    if (ref !== `driver:${this.generation}`) throw new Error("stale driver ref");
    return { text: "Delete", role: "button", index: 0, selector: "#delete" };
  }
  override async click(target: Target, ref?: string) {
    if (ref) { await this.locateRef(ref); this.refs.push(ref); }
    else if (target.text === "Old") throw new Error("missing");
    else throw new Error("unexpected name dispatch");
  }
}
const refOf = (prompt: string) => prompt.match(/ref="([^"]+)"/)![1];
class DynamicLlm implements LlmClient {
  readonly id = "dynamic";
  prompts: string[] = [];
  constructor(readonly reply: (prompt: string, n: number) => object) {}
  async complete(prompt: string) { this.prompts.push(prompt); return JSON.stringify(this.reply(prompt, this.prompts.length)); }
}
const original: Step = { kind: "click", target: { text: "Old" }, intent: "delete record", expect: { text: "Removed" } };

it("discover policy sees canonical ref-only target and blocks it before actuation", async () => {
  const driver = new ExactDriver();
  const seen: string[] = [];
  const llm = new DynamicLlm((prompt, n) => n <= 3 ? { action: "click", ref: refOf(prompt) } : { assertions: [] });
  const result = await discover("delete record", { driver, llm, maxSteps: 3, policy: { vet(d) { seen.push(d.text!); return { ok: false, reason: "protected" }; } } });
  expect(seen).toEqual(["Delete", "Delete", "Delete"]);
  expect(driver.refs).toEqual([]);
  expect(result.truncated).toBe(true);
  expect(llm.prompts[1]).toContain("- [button] Delete");
  expect(llm.prompts[1]).not.toContain("unchanged from previous step");
  expect(refOf(llm.prompts[1]!)).not.toBe(refOf(llm.prompts[0]!));
});

it("explore detects a no-op despite rotating refs and forwards current exact selection", async () => {
  const driver = new ExactDriver();
  const llm = new DynamicLlm((prompt, n) => n === 1 ? { action: "click", ref: refOf(prompt) } : { action: "done" });
  const result = await explore("survey", { driver, llm, baseUrl: "https://app/start", maxSteps: 2 });
  expect(driver.refs).toHaveLength(1);
  expect(result.findings.some(f => f.kind === "dead-action")).toBe(true);
  expect(llm.prompts[1]).toContain("- [button] Delete");
  expect(llm.prompts[1]).not.toContain("unchanged from previous step");
  expect(JSON.stringify(result.steps)).not.toContain("ref");
});

it("step heal uses current exact refs and retains original intent and expect", async () => {
  const driver = new ExactDriver();
  const llm = new DynamicLlm(prompt => ({ action: "click", ref: refOf(prompt) }));
  const result = await new LlmStepHealer(llm).heal(original, 2, driver);
  expect(result?.step).toMatchObject({ target: { selector: "#delete" }, intent: original.intent, expect: original.expect });
  expect(driver.refs).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("driver:");
});

it("locate heal accepts current refs and dispatches the selected node without name fallback", async () => {
  const driver = new ExactDriver();
  const llm = new DynamicLlm(prompt => ({ ref: refOf(prompt) }));
  const healed = new SelfHealingDriver(driver, llm);
  await healed.click({ text: "Old" });
  expect(driver.refs).toHaveLength(1);
  expect(healed.heals[0]?.healed.selector).toBe("#delete");
});

it("both healing paths reject ambiguous legacy name choices", async () => {
  const driver = new StubDriver();
  driver.els = [{ role: "button", name: "Same" }, { role: "button", name: "Same" }];
  const result = await new LlmStepHealer(new DynamicLlm(() => ({ action: "click", text: "Same" }))).heal(original, 0, driver);
  expect(result).toBeNull();
  expect(driver.clicked).toEqual([]);
  class MissingDriver extends StubDriver {
    override async click(target: Target) { if (target.text === "Old") throw new Error("missing"); return super.click(target); }
  }
  const missing = new MissingDriver(); missing.els = driver.els;
  await expect(new SelfHealingDriver(missing, new DynamicLlm(() => ({ name: "Same" }))).click({ text: "Old" })).rejects.toThrow(/nth|ambiguous/);
  expect(missing.clicked).toEqual([]);
});

it("step and locate healing policies see canonical targets and prevent exact dispatch", async () => {
  const seen: string[] = [];
  const policy = { vet(d: { text?: string }) { seen.push(d.text!); return { ok: false as const, reason: "protected" }; } };
  const driver = new ExactDriver();
  const stepResult = await new LlmStepHealer(new DynamicLlm(p => ({ action: "click", ref: refOf(p) })), 5, {}, { policy }).heal(original, 0, driver);
  expect(stepResult).toBeNull();
  await expect(new SelfHealingDriver(driver, new DynamicLlm(p => ({ ref: refOf(p) })), { policy }).click({ text: "Old" })).rejects.toThrow(/policy/);
  expect(seen).toEqual(["Delete", "Delete"]);
  expect(driver.refs).toEqual([]);
});

it("explore applies perception corrections without changing reference identity", async () => {
  const driver = new ExactDriver();
  const llm = new DynamicLlm(() => ({ action: "done" }));
  await explore("survey", { driver, llm, baseUrl: "https://app/start", perceive: rows => rows.map(e => ({ ...e, checked: true })) });
  expect(llm.prompts[0]).toContain("(checked)");
  expect(llm.prompts[0]).not.toContain("driver:");
});

it("discover exposes a trailing active portal from a custom driver within its prompt budget", async () => {
  const driver = new StubDriver();
  driver.els = [...Array.from({ length: 80 }, (_, i) => ({ role: "button", name: `Background ${i}` })), { role: "option", name: "Portal choice", inActivePopup: true }];
  const llm = new DynamicLlm((_prompt, n) => n === 1 ? { action: "done" } : { assertions: [] });
  await discover("choose", { driver, llm });
  expect(llm.prompts[0]).toContain("- [option] Portal choice");
  expect(llm.prompts[0]!.match(/^- \[/gm)).toHaveLength(60);
});

it("secret value redaction preserves a literal accessible name and opaque ref during discovery and step heal", async () => {
  const secret = "alice@example.com";
  const name = `Continue as ${secret}`;
  const opaqueRef = `driver-node:${secret}`;
  class SecretNamedDriver extends StubDriver {
    dispatched: string[] = [];
    override async snapshot(): Promise<PageElement[]> {
      return [{ role: "button", name, value: secret, ref: opaqueRef }];
    }
    async locateRef(ref: string): Promise<Target> {
      expect(ref).toBe(opaqueRef);
      return { text: name, role: "button", index: 0, selector: "#continue" };
    }
    override async click(_target: Target, ref?: string): Promise<void> {
      expect(ref).toBe(opaqueRef);
      this.dispatched.push(ref!);
    }
  }
  const driver = new SecretNamedDriver();
  const llm = new DynamicLlm((prompt, n) => n === 1 ? { action: "click", ref: refOf(prompt) } : n === 2 ? { action: "done" } : { assertions: [] });
  const scenario = await discover("continue", { driver, llm, secrets: { user: secret } });
  expect(driver.dispatched).toEqual([opaqueRef]);
  expect(llm.prompts[0]).toContain(name);
  expect(llm.prompts[0]).toContain('= "{user}"');
  expect(llm.prompts[0]).not.toContain(opaqueRef);
  expect(scenario.steps[0]).toMatchObject({ target: { text: name, selector: "#continue" } });

  const healerLlm = new DynamicLlm(prompt => ({ action: "click", ref: refOf(prompt) }));
  const healed = await new LlmStepHealer(healerLlm, 5, { user: secret }).heal(original, 0, driver);
  expect(healed?.step).toMatchObject({ target: { text: name, selector: "#continue" } });
  expect(healerLlm.prompts[0]).toContain('= "{user}"');
  expect(healerLlm.prompts[0]).not.toContain(opaqueRef);
  expect(driver.dispatched).toEqual([opaqueRef, opaqueRef]);
});
