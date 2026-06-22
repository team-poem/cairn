/**
 * File-backed SkillStore. A frozen skill is plain JSON `{ name, scenario }`; freezing turns
 * an expensive LLM discovery into a cheap, repeatable, LLM-free replay (invariant #4).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SkillStore, Skill } from "../../core/ports.js";
import type { Scenario } from "../../core/types.js";

export class FileSkillStore implements SkillStore {
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

  async freeze(name: string, scenario: Scenario): Promise<string> {
    const path = this.pathFor(name);
    await mkdir(dirname(path), { recursive: true });
    const skill: Skill = { name, scenario };
    await writeFile(path, JSON.stringify(skill, null, 2), "utf8");
    return path;
  }
}

/** Load a frozen skill by path, accepting either a full `{name,scenario}` or a bare scenario. */
export async function loadSkillFile(path: string): Promise<Skill> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Skill | Scenario;
  if ("scenario" in parsed) return parsed as Skill;
  const scenario = parsed as Scenario;
  return { name: scenario.name, scenario };
}
