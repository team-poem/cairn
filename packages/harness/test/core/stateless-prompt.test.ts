import { describe, expect, it } from "vitest";
import { discover } from "../../src/core/discover/index.js";
import { explore } from "../../src/core/explore/index.js";
import { FakeDriver } from "../../src/adapters/drivers/fake.js";
import type { LlmClient } from "../../src/core/ports.js";
import type { Evidence, PageElement } from "../../src/core/types.js";

const HEADER = "Interactive elements now on the page:\n";
const evidence: Evidence = {
  execution: { actions: [], navigated: false, finalUrl: "https://shop/", blocked: false },
  perception: {},
  logic: { requests: [], console: [] },
};
const elements: PageElement[] = [
  { role: "textbox", name: "Name" },
  { role: "button", name: "Save" },
];

/**
 * The port is one `complete(prompt)` with no conversation, so a prompt may never refer to a turn
 * the model cannot see. This client answers only from the prompt it is handed: it acts on an
 * element when the listing offers one and gives up when it does not, which is what a real model
 * did when the listing was elided from the second turn onward (#225).
 */
class PromptOnlyLlm implements LlmClient {
  readonly id = "prompt-only";
  readonly prompts: string[] = [];
  private acted = 0;
  constructor(private readonly want: string[]) {}
  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const listing = this.listingIn(prompt);
    if (listing === undefined) return "[]"; // the assertion proposal, not a loop turn
    const next = this.want[this.acted];
    if (next === undefined || !listing.includes(next)) {
      return '{"action":"done","reason":"no interactive element list was provided","assertions":[]}';
    }
    this.acted++;
    return JSON.stringify({ action: "click", text: next, reason: `act on ${next}` });
  }
  /** Selected by the header rather than by index: another call before or inside the loop must not
   * silently turn "turn 2" into a prompt that has no listing at all. */
  private listingIn(prompt: string): string | undefined {
    return prompt.includes(HEADER) ? prompt.split(HEADER)[1]!.split("\n\n")[0] : undefined;
  }
  get turns(): string[] {
    return this.prompts.filter((p) => p.includes(HEADER)).map((p) => this.listingIn(p)!);
  }
}

const manyElements = (): PageElement[] => [
  { role: "textbox", name: "Name", value: "half typed" },
  { role: "button", name: "Save", disabled: true },
  { role: "checkbox", name: "Remember me", checked: true },
  ...Array.from({ length: 60 }, (_, i) => ({ role: "link", name: `Filler ${i}` }) as PageElement),
];

describe("a prompt never points at a turn the model cannot see (#225)", () => {
  it("discoverListsElementsEveryTurn: a stable page is listed again on every turn", async () => {
    const driver = new FakeDriver({ evidence, elements });
    const llm = new PromptOnlyLlm(["Name", "Save"]);

    const scenario = await discover("enter a name and save it", { driver, llm, baseUrl: "https://shop" });

    // Two actions and the `done` that follows them, counted over loop turns only.
    expect(llm.turns).toHaveLength(3);
    for (const listing of llm.turns) {
      expect(listing).toContain("[textbox] Name");
      expect(listing).toContain("[button] Save");
    }
    expect(llm.prompts.join("\n")).not.toContain("unchanged from previous step");
    // The journey actually happened, which is what an elided listing prevented.
    expect(scenario.steps.filter((s) => s.kind === "click")).toHaveLength(2);
  });

  it("discoverRepeatsPerTurnState: every turn carries the state and the cap notice, not just the names", async () => {
    const driver = new FakeDriver({ evidence, elements: manyElements() });
    const llm = new PromptOnlyLlm(["Remember me", "Remember me"]);

    await discover("remember me on this device", { driver, llm, baseUrl: "https://shop" });

    // A listing compressed to bare names would still satisfy a name check, so the fields the
    // listing exists to carry are pinned on a later turn too.
    expect(llm.turns.length).toBeGreaterThanOrEqual(2);
    for (const listing of llm.turns.slice(1)) {
      expect(listing).toContain("(checked)");
      expect(listing).toContain("(disabled)");
      expect(listing).toContain('= "half typed"');
      expect(listing).toContain("more elements not shown");
    }
  });

  it("exploreListsElementsEveryTurn: the survey loop does not elide the page either", async () => {
    const driver = new FakeDriver({ evidence, elements });
    const llm = new PromptOnlyLlm(["Name", "Save"]);

    await explore("survey the shop", { driver, llm, baseUrl: "https://shop", maxSteps: 4 });

    expect(llm.turns.length).toBeGreaterThanOrEqual(3);
    for (const listing of llm.turns) expect(listing).toContain("[textbox] Name");
    expect(llm.prompts.join("\n")).not.toContain("unchanged from previous step");
  });
});
