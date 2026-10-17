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

it("locatorHealWithoutReferencesTeachesNamedRepair: no validated ref table means no ref instructions or examples (#301)", async () => {
  for (const rows of [
    [{ role: "button", name: "Save" }, { role: "button", name: "Save" }],
    [{ role: "button", name: 'ref="o1-0" Save' }],
    [],
  ]) {
    const driver = new LocatorPromptDriver();
    driver.els = rows;
    const systems: string[] = [];
    const llm: LlmClient = { id: "locator-named", async complete(_prompt, opts) {
      systems.push(opts?.system ?? "");
      return rows.length ? JSON.stringify({ name: rows[0]!.name, role: "button", ...(rows.length > 1 ? { nth: 1 } : {}) }) : '{"name":null}';
    } };
    const healer = new SelfHealingDriver(driver, llm);
    if (rows.length) await healer.click({ text: "Old save" });
    else await expect(healer.click({ text: "Old save" })).rejects.toThrow(/no match/);
    const system = systems[0]!;
    expect(system).toContain('No references are available in this observation; do not include "ref"');
    expect(system).not.toContain("reference table");
    expect(system).toContain('"nth"');
    const examples = [...system.matchAll(/\{[^{}]*\}/g)].map(match => JSON.parse(match[0]) as Record<string, unknown>);
    expect(examples.some(example => "ref" in example)).toBe(false);
    expect(examples.some(example => example.name === null)).toBe(true);
    if (rows.length > 1) expect(driver.repaired).toEqual([{ target: { text: "Save", role: "button", nth: 1 } }]);
  }
});

it("locatorHealInstructionsTrackEachObservation: a later repair without refs drops the ref schema (#301)", async () => {
  const driver = new LocatorPromptDriver();
  const systems: string[] = [];
  const llm: LlmClient = { id: "locator-capability", async complete(_prompt, opts) {
    systems.push(opts?.system ?? "");
    return '{"name":"Save","role":"button","nth":1}';
  } };
  const healer = new SelfHealingDriver(driver, llm);
  await healer.click({ text: "Old save" });
  driver.els = driver.els.map(({ ref: _ref, ...row }) => row);
  await healer.click({ text: "Old save" });
  expect(systems[0]).toContain('{"ref":"<current reference>"}');
  expect(systems[1]).not.toContain('"ref":');
  expect(systems[1]).toContain("No references are available");
});
