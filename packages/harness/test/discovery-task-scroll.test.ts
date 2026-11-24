import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  checkpointEvidence, discover, discoverWithTasks, loadSkillFile, runScenario, saveSkillFile,
  type LlmClient, type Step,
} from "../src/index.js";
import { StubDriver } from "./support/doubles.js";

const baseUrl = "https://terms.test/";
const after: Step[] = [
  { kind: "goto", url: baseUrl },
  { kind: "click", target: { role: "button", text: "Open terms" } },
  { kind: "scroll", direction: "down" },
];

class TermsDriver extends StubDriver {
  scrolls = 0;
  override async snapshot() {
    return this.url === baseUrl ? [{ role: "button", name: "Open terms" }] :
      [{ role: "heading", name: this.scrolls ? "Footer reviewed" : "Terms" }];
  }
  override async scroll() { this.scrolls++; }
  constructor() { super(baseUrl); this.navOn["Open terms"] = baseUrl + "terms"; }
}

function model(): LlmClient {
  const replies = [{ action: "click", role: "button", text: "Open terms" }, { action: "scroll", direction: "down" }];
  return { id: "terms", async complete(prompt) {
    if (prompt.includes("Propose the verification assertions.")) return "[]";
    return JSON.stringify(replies.shift() ?? { action: "done" });
  } };
}

it("preserves a required scroll and its checkpoint prefix on fresh replay, without changing ordinary discovery", async () => {
  const ordinary = await discover("Open the terms and inspect the footer", { baseUrl, driver: new TermsDriver(), llm: model() });
  expect(ordinary.steps.map(s => s.kind)).toEqual(["goto", "click"]);

  const { scenario, progress } = await discoverWithTasks("Open the terms and inspect the footer", {
    baseUrl, driver: new TermsDriver(), llm: model(), taskPlan: {
      ordered: true, onFailure: "stop",
      tasks: [{ id: "open", instruction: "Open terms" }, { id: "read", instruction: "Scroll to the footer" }],
      match: d => d.action === "scroll" && d.direction === "down" ? "read" :
        d.action === "click" && d.text === "Open terms" ? "open" : undefined,
      assess(id, _step, ctx) {
        const ok = id === "open" ? ctx.url === baseUrl + "terms" : ctx.elements.some(e => e.name === "Footer reviewed");
        return { route: ok ? "completed" : "unavailable", verification: ok ? "passed" : "failed" };
      },
    },
  });
  expect(progress.completed).toEqual(["open", "read"]);
  expect(scenario.truncated).not.toBe(true);

  const dir = await mkdtemp(join(tmpdir(), "cairn-required-scroll-"));
  try {
    const path = join(dir, "terms.skill.json");
    await saveSkillFile(path, scenario);
    const stored = await loadSkillFile(path);
    expect(stored.steps.map(s => s.kind)).toEqual(["goto", "click", "scroll"]);
    const driver = new TermsDriver();
    const point = { id: "footer", after, elements: true };
    const { result } = await runScenario(stored, {
      driver, reporter: { emit: async () => {} }, evidenceCapture: { checkpoints: [point] },
    });
    expect(driver.scrolls).toBe(1);
    expect(result.verdict.passed).toBe(true);
    expect(result.usage?.llmCalls).toBe(0);
    expect(await checkpointEvidence(result.evidence, point)).toMatchObject({
      status: "captured", elements: [{ role: "heading", name: "Footer reviewed" }],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
