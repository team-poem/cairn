import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileSkillStore, loadSkillFile } from "./file-store.js";
import type { Scenario } from "../types.js";

const scenario: Scenario = {
  name: "frozen-scenario",
  steps: [
    { kind: "goto", url: "https://example.com" },
    { kind: "click", target: { text: "Learn more" } },
  ],
  assertions: [{ kind: "navigated" }],
};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-skills-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FileSkillStore", () => {
  it("freezes and resolves a scenario round-trip", async () => {
    const store = new FileSkillStore(dir);
    const path = await store.freeze("frozen-scenario", scenario);
    const skill = await store.resolve("frozen-scenario");
    expect(skill?.scenario).toEqual(scenario);

    // loadSkillFile reads the same artifact by path.
    const byPath = await loadSkillFile(path);
    expect(byPath.scenario).toEqual(scenario);
  });

  it("returns undefined for a missing skill", async () => {
    const store = new FileSkillStore(dir);
    expect(await store.resolve("nope")).toBeUndefined();
  });
});
