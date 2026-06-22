/**
 * File-backed SkillStore: freeze a discovered Scenario to disk, resolve it later for
 * deterministic replay (invariant #4 — the replay path reads a frozen skill and runs it
 * with no LLM in the loop).
 *
 * A frozen skill is plain JSON: `{ name, scenario }`. Freezing is what turns an
 * expensive LLM discovery into a cheap, repeatable regression.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SkillStore, Skill } from "../../core/ports.js";
import type { Scenario } from "../../core/types.js";

export class FileSkillStore implements SkillStore {
  /** @param dir directory that holds `<name>.json` skill files. */
  constructor(private readonly dir: string) {}

  private pathFor(name: string): string {
    return join(this.dir, `${name}.json`);
  }

  async resolve(name: string): Promise<Skill | undefined> {
    try {
      const raw = await readFile(this.pathFor(name), "utf8");
      return JSON.parse(raw) as Skill;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  /** Freeze a scenario under a name; returns the written path. */
  async freeze(name: string, scenario: Scenario): Promise<string> {
    const path = this.pathFor(name);
    await mkdir(dirname(path), { recursive: true });
    const skill: Skill = { name, scenario };
    await writeFile(path, JSON.stringify(skill, null, 2), "utf8");
    return path;
  }
}

/** Load a frozen skill from an explicit file path (used by `cairn replay <file>`). */
export async function loadSkillFile(path: string): Promise<Skill> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Skill | Scenario;
  // Accept either a full skill `{name,scenario}` or a bare scenario.
  if ("scenario" in parsed) return parsed as Skill;
  const scenario = parsed as Scenario;
  return { name: scenario.name, scenario };
}
