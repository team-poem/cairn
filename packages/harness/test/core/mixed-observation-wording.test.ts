import { expect, it } from "vitest";
import { discover } from "../../src/core/discover/index.js";
import { explore } from "../../src/core/explore/index.js";
import { LlmStepHealer } from "../../src/core/step-heal.js";
import { SYSTEM } from "../../src/core/discover/prompt.js";
import { EXPLORE_SYSTEM } from "../../src/core/explore/prompt.js";
import { healSystem } from "../../src/adapters/drivers/self-heal.js";
import type { LlmClient } from "../../src/core/ports.js";
import type { PageElement, Target } from "../../src/core/types.js";
import { StubDriver } from "../support/doubles.js";

class RefDriver extends StubDriver {
  constructor(rows: PageElement[]) { super(); this.els = rows; }
  async locateRef(ref: string): Promise<Target> {
    const row = this.els.find(e => e.ref === ref)!;
    return { text: row.name, role: row.role };
  }
}
const rows: PageElement[] = [
  { role: "link", name: "Alpha Curated goods from the Alpha store", ref: "n-link" },
  { role: "heading", name: "Alpha", ref: "n-heading" },
];
function capture(): { llm: LlmClient; prompts: string[] } {
  const prompts: string[] = [];
  return { prompts, llm: { id: "wording", async complete(prompt) {
    if (!prompt.includes("What is the single next action?") && !prompt.includes("Reply with the single next action")) return "[]";
    prompts.push(prompt);
    return '{"action":"done"}';
  } } };
}

it("mixedObservationWording: every loop prompt labels a mixed listing as observed elements and lists each element once with its ref", async () => {
  const d = capture();
  await discover("open alpha", { driver: new RefDriver(rows), llm: d.llm, baseUrl: "https://app/", maxSteps: 1 });
  const e = capture();
  await explore("survey", { driver: new RefDriver(rows), llm: e.llm, baseUrl: "https://app/", maxSteps: 1 });
  const h = capture();
  await new LlmStepHealer(h.llm).heal({ kind: "click", target: { text: "Alpha" }, intent: "open alpha" }, 0, new RefDriver(rows));
  for (const prompt of [d.prompts[0]!, e.prompts[0]!, h.prompts[0]!]) {
    expect(prompt).not.toMatch(/interactive elements/i);
    expect(prompt).toContain("Observed page elements:");
    expect(prompt.match(/\[heading\] Alpha/g)).toHaveLength(1);
    expect(prompt.match(/\[link\] Alpha Curated/g)).toHaveLength(1);
    expect(prompt).toMatch(/ref="[^"]+" \[heading\] Alpha/);
  }
});

it("mixedObservationWording: system prompts call text rows state evidence and keep unmarked widgets unknown", () => {
  for (const system of [SYSTEM, EXPLORE_SYSTEM, healSystem(true)]) {
    expect(system).not.toMatch(/interactive elements/i);
    expect(system).toMatch(/context rows/);
  }
  expect(SYSTEM).toContain("state evidence, not recommended action targets");
  expect(SYSTEM).toContain("unknown, not forbidden");
});
