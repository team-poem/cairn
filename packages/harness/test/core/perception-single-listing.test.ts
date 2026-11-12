import { it, expect } from "vitest";
import { StubDriver } from "../support/doubles.js";
import type { PageElement, SnapshotOptions, Step, Target } from "../../src/core/types.js";
import type { LlmClient } from "../../src/core/ports.js";
import { discover } from "../../src/core/discover/index.js";
import { explore } from "../../src/core/explore/index.js";
import { LlmStepHealer } from "../../src/core/step-heal.js";
import { SelfHealingDriver } from "../../src/adapters/drivers/self-heal.js";

/** Two duplicate referenced Save buttons, one referenced Delete, one unreferenced Archive.
 * `refsOff` simulates a capable driver that returns no refs for one capture. */
class MixedDriver extends StubDriver {
  refsOff = false;
  override async snapshot(options?: SnapshotOptions): Promise<PageElement[]> {
    const ref = (id: string) => options?.perception && !this.refsOff ? { ref: id } : {};
    return [
      { role: "button", name: "Save", ...ref("n-save-0") },
      { role: "button", name: "Save", ...ref("n-save-1") },
      { role: "button", name: "Delete", ...ref("n-delete") },
      { role: "button", name: "Archive" },
    ];
  }
  async locateRef(ref: string): Promise<Target> {
    return { text: ref, role: "button", selector: `#${ref}` };
  }
  override async click(target: Target, ref?: string) {
    if (!ref && target.text === "Old") throw new Error("missing");
  }
}

class RecordingLlm implements LlmClient {
  readonly id = "recording";
  prompts: string[] = [];
  constructor(private readonly reply: (n: number) => string) {}
  async complete(prompt: string) { this.prompts.push(prompt); return this.reply(this.prompts.length); }
}

const listingLines = (prompt: string) => prompt.split("\n").filter(line => /^- (ref="[^"]+" )?\[/.test(line));

function expectSingleMixedListing(prompt: string) {
  const lines = listingLines(prompt);
  expect(lines).toHaveLength(4);
  expect(lines[0]).toMatch(/^- ref="[^"]+" \[button\] Save \(nth=0\)$/);
  expect(lines[1]).toMatch(/^- ref="[^"]+" \[button\] Save \(nth=1\)$/);
  expect(lines[2]).toMatch(/^- ref="[^"]+" \[button\] Delete$/);
  expect(lines[3]).toBe("- [button] Archive");
  expect(prompt).not.toContain("Current observation references");
}

it("singleListingAcrossConsumers: discover, explore, step heal and locator heal list each selected element once with its ref inline", async () => {
  const prompts: string[] = [];
  for (const mode of ["discover", "explore"] as const) {
    const llm = new RecordingLlm(() => '{"action":"done"}');
    const options = { driver: new MixedDriver(), llm, baseUrl: "https://app/start", maxSteps: 1 };
    await (mode === "discover" ? discover("save", options) : explore("save", options));
    prompts.push(llm.prompts[0]!);
  }
  const step: Step = { kind: "click", target: { text: "Old" }, intent: "save" };
  const stepLlm = new RecordingLlm(() => '{"action":"done"}');
  await new LlmStepHealer(stepLlm).heal(step, 0, new MixedDriver());
  prompts.push(stepLlm.prompts[0]!);
  const locateLlm = new RecordingLlm(() => '{"name":null}');
  await new SelfHealingDriver(new MixedDriver(), locateLlm).click({ text: "Old" }).catch(() => undefined);
  prompts.push(locateLlm.prompts[0]!);

  expect(prompts).toHaveLength(4);
  for (const prompt of prompts) expectSingleMixedListing(prompt);
});

it("singleListingTracksCapabilityChanges: a turn without refs keeps the full named listing, and refs return on the next turn", async () => {
  for (const mode of ["discover", "explore"] as const) {
    const driver = new MixedDriver();
    const llm = new RecordingLlm(n => {
      driver.refsOff = n === 1;
      return n < 3 ? '{"action":"pressKey","key":"Escape"}' : '{"action":"done"}';
    });
    await (mode === "discover"
      ? discover("save", { driver, llm, maxSteps: 3 })
      : explore("save", { driver, llm, baseUrl: "https://app/start", maxSteps: 3 }));
    const decisions = llm.prompts.filter(p => p.includes("What is the single next action?"));
    expect(decisions.length, mode).toBe(3);
    expectSingleMixedListing(decisions[0]!);
    expect(listingLines(decisions[1]!)).toEqual([
      "- [button] Save (nth=0)", "- [button] Save (nth=1)", "- [button] Delete", "- [button] Archive",
    ]);
    expect(decisions[1]).not.toContain("ref=");
    expectSingleMixedListing(decisions[2]!);
  }
});
