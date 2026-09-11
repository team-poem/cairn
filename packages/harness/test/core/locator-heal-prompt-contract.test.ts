// file: packages/harness/test/core/locator-heal-prompt-contract.test.ts
import { expect, it } from "vitest";
import { SelfHealingDriver } from "../../src/adapters/drivers/self-heal.js";
import type { LlmClient } from "../../src/core/ports.js";
import type { Target } from "../../src/core/types.js";
import { StubDriver } from "../support/doubles.js";

class LocatorPromptDriver extends StubDriver {
  readonly repaired: Array<{ target: Target; ref?: string }> = [];
  constructor() {
    super();
    this.els = [{ role: "button", name: "Save", ref: "first" }, { role: "button", name: "Save", ref: "second" }];
  }
  async locateRef(ref: string): Promise<Target> {
    const index = this.els.findIndex(row => row.ref === ref);
    if (index < 0) throw new Error("unknown reference");
    return { text: "Save", role: "button", nth: index, selector: `#${ref}` };
  }
  override async click(target: Target, ref?: string): Promise<void> {
    if (target.text === "Old save") throw new Error("element not found: Old save");
    this.repaired.push({ target, ...(ref ? { ref } : {}) });
  }
}
function locatorPromptRef(prompt: string): string {
  const row = prompt.split("\n").find(line => line.includes("ref=") && line.includes("nth=1"));
  const ref = row?.match(/ref="([^"]+)"/)?.[1];
  if (!ref) throw new Error("missing second duplicate reference");
  return ref;
}

it("locatorHealPromptTeachesOnlyLocatorResponses: every complete JSON example matches the locator parser without action or mandatory reason fields", async () => {
  const driver = new LocatorPromptDriver();
  const systems: string[] = [];
  const llm: LlmClient = { id: "locator-schema", async complete(_prompt, opts) {
    systems.push(opts?.system ?? "");
    return '{"name":"Save","role":"button","nth":1}';
  } };
  const healer = new SelfHealingDriver(driver, llm);
  await healer.click({ text: "Old save" });
  expect(driver.repaired).toEqual([{ target: { text: "Save", role: "button", nth: 1 } }]);
  expect(healer.heals).toHaveLength(1);
  expect(systems).toHaveLength(1);
  const examples = [...systems[0]!.matchAll(/\{[^{}]*\}/g)].map(match => JSON.parse(match[0]) as Record<string, unknown>);
  expect(examples.some(example => example.name === null)).toBe(true);
  expect(examples.some(example => typeof example.name === "string")).toBe(true);
  expect(examples.some(example => typeof example.ref === "string")).toBe(true);
  for (const example of examples) {
    expect(Object.keys(example).every(key => ["name", "ref", "role", "nth"].includes(key))).toBe(true);
    expect("name" in example || "ref" in example).toBe(true);
  }
  expect(systems[0]).not.toMatch(/always add ["']reason/i);
  expect(systems[0]).not.toMatch(/(?:respond with|choose|return) (?:one |a |the )?(?:next )?action/i);
});

it("locatorHealRefRulesUseTheLocatorNameField: ref-only repair selects a duplicate with schema-specific description guidance", async () => {
  const driver = new LocatorPromptDriver();
  const systems: string[] = [];
  const llm: LlmClient = { id: "locator-ref-schema", async complete(prompt, opts) {
    systems.push(opts?.system ?? "");
    return JSON.stringify({ ref: locatorPromptRef(prompt) });
  } };
  const healer = new SelfHealingDriver(driver, llm);
  await healer.click({ text: "Old save" });
  expect(driver.repaired).toEqual([{ target: { text: "Save", role: "button", nth: 1, selector: "#second" }, ref: "second" }]);
  expect(healer.heals).toEqual([{ original: { text: "Old save" }, healed: { text: "Save", role: "button", nth: 1, selector: "#second" } }]);
  const system = systems[0]!;
  expect(system).toMatch(/ref[\s\S]{0,160}(?:current|this) (?:observation|decision)/i);
  expect(system).toMatch(/(?:without|omit|optional)[\s\S]{0,100}(?:["']?name["']?)[\s\S]{0,50}role[\s\S]{0,50}nth/i);
  expect(system).not.toContain('"action":');
  expect(JSON.stringify(healer.heals)).not.toContain('"ref"');
});
