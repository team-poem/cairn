import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FileSkillStore,
  InvalidSkillFileError,
  loadSkillFile,
  saveSkillFile,
} from "../../../src/adapters/skills/file-store.js";
import type { SkillStore } from "../../../src/core/ports.js";
import type { Scenario } from "../../../src/core/types.js";

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

describe("FileSkillStore (SkillStore port)", () => {
  it("freezes and loads a scenario round-trip through the port", async () => {
    const store: SkillStore = new FileSkillStore(dir);
    const path = await store.freeze("cart.skill.json", scenario);
    expect(path).toBe(join(dir, "cart.skill.json"));

    const loaded = await store.load("cart.skill.json");
    expect(loaded).toEqual(scenario);

    // The frozen artifact is the bare Scenario JSON — no wrapper (living contract).
    const frozen = JSON.parse(await readFile(path, "utf8"));
    expect(frozen).toEqual(scenario);
    expect(frozen).not.toHaveProperty("scenario");

    // loadSkillFile reads the same artifact by path — one mechanism, two entrances.
    expect(await loadSkillFile(path)).toEqual(scenario);
  });

  it("treats an absolute reference as the path itself", async () => {
    const store = new FileSkillStore(); // default base: cwd — irrelevant for absolute refs
    const abs = join(dir, "abs.skill.json");
    expect(await store.freeze(abs, scenario)).toBe(abs);
    expect(await store.load(abs)).toEqual(scenario);
  });

  it("rejects a missing skill with a not-found error", async () => {
    const store = new FileSkillStore(dir);
    await expect(store.load("nope.skill.json")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a malformed skill file with InvalidSkillFileError", async () => {
    const bad = join(dir, "bad.skill.json");
    await writeFile(bad, JSON.stringify({ name: "x" }), "utf8"); // no steps/assertions
    const store = new FileSkillStore(dir);
    await expect(store.load("bad.skill.json")).rejects.toBeInstanceOf(InvalidSkillFileError);
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
