import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileSkillStore, loadSkillFile, saveSkillFile } from "./file-store.js";
import type { Scenario } from "../../core/types.js";

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
    const resolved = await store.resolve("frozen-scenario");
    expect(resolved).toEqual(scenario);

    const frozen = JSON.parse(await readFile(path, "utf8"));
    expect(frozen).toEqual(scenario);
    expect(frozen).not.toHaveProperty("scenario");

    // loadSkillFile reads the same artifact by path.
    const byPath = await loadSkillFile(path);
    expect(byPath).toEqual(scenario);
  });

  it("returns undefined for a missing skill", async () => {
    const store = new FileSkillStore(dir);
    expect(await store.resolve("nope")).toBeUndefined();
  });
});

describe("saveSkillFile", () => {
  it("writes a bare Scenario file that loadSkillFile reads back", async () => {
    const path = join(dir, "nested", "cart.skill.json");
    await saveSkillFile(path, scenario); // creates parent directories

    const frozen = JSON.parse(await readFile(path, "utf8"));
    expect(frozen).toEqual(scenario);
    expect(frozen).not.toHaveProperty("scenario"); // no {name, scenario} wrapper

    expect(await loadSkillFile(path)).toEqual(scenario);
  });
});
