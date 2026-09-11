import { expect, it } from "vitest";
import { StubDriver } from "../support/doubles.js";
import { SelfHealingDriver } from "../../src/adapters/drivers/self-heal.js";
import { runScenario } from "../../src/run.js";
import type { PageElement, Scenario, Target } from "../../src/core/types.js";
import type { LlmClient } from "../../src/core/ports.js";

const secret = "actual-password-987";
const opaqueRef = `node:${secret}`;
class PasswordDriver extends StubDriver {
  typed: string[] = [];
  override async snapshot(): Promise<PageElement[]> { return [{ role: "textbox", name: "Password", value: secret, ref: opaqueRef }]; }
  async locateRef(ref: string): Promise<Target> { expect(ref).toBe(opaqueRef); return { text: "Password", role: "textbox", selector: "#password" }; }
  override async type(target?: Target, value?: string, ref?: string): Promise<void> {
    if (target?.text === "Old password") throw new Error("target missing");
    expect(ref).toBe(opaqueRef);
    this.typed.push(value!);
  }
}
class RefLlm implements LlmClient {
  readonly id = "test";
  prompts: string[] = [];
  async complete(prompt: string) {
    this.prompts.push(prompt);
    return JSON.stringify({ ref: prompt.match(/ref="([^"]+)"/)![1] });
  }
}

it("locate heal masks configured input values while preserving exact refs and sanitized policy values", async () => {
  const driver = new PasswordDriver();
  const llm = new RefLlm();
  const observed: unknown[] = [];
  const healer = new SelfHealingDriver(driver, llm, { secrets: { password: secret }, policy: { vet(decision) { observed.push(decision); return { ok: true }; } }, onHeal: heal => observed.push(heal) });
  await healer.type({ text: "Old password" }, secret);
  expect(driver.typed).toEqual([secret]);
  expect(llm.prompts[0]).toContain('= "{password}"');
  expect(llm.prompts[0]).not.toContain(secret);
  expect(observed[0]).toMatchObject({ value: "{password}", text: "Password" });
  expect(JSON.stringify(observed)).not.toContain(secret);
});

it("runScenario passes secrets into locate heal and keeps healed traces and callbacks value-free", async () => {
  const driver = new PasswordDriver();
  const llm = new RefLlm();
  const published: unknown[] = [];
  const scenario: Scenario = { name: "fill password", steps: [{ kind: "type", target: { text: "Old password" }, text: "{password}" }], assertions: [{ kind: "no-console-errors" }] };
  const result = await runScenario(scenario, { driver, llm, heal: true, secrets: { password: secret }, reporter: { emit: async () => {} }, onHeal: heal => published.push(heal), onStep: progress => published.push(progress), trace: { emit: event => published.push(event) } });
  expect(result.heals).toHaveLength(1);
  expect(driver.typed).toEqual([secret]);
  expect(llm.prompts[0]).toContain('= "{password}"');
  expect(llm.prompts[0]).not.toContain(secret);
  expect(JSON.stringify(published)).not.toContain(secret);
  expect(JSON.stringify(result.healedScenario)).not.toContain(secret);
});
