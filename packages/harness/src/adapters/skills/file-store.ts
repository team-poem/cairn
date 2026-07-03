/**
 * File-backed SkillStore. A frozen skill is a plain Scenario JSON file; freezing turns
 * an expensive LLM discovery into a cheap, repeatable, LLM-free replay (invariant #4).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SkillStore } from "../../core/ports.js";
import type { Scenario } from "../../core/types.js";

export class FileSkillStore implements SkillStore {
  constructor(private readonly dir: string) {}

  private pathFor(name: string): string {
    return join(this.dir, `${name}.json`);
  }

  async resolve(name: string): Promise<Scenario | undefined> {
    try {
      return await loadSkillFile(this.pathFor(name));
    } catch (err) {
      if (isNotFoundError(err)) return undefined;
      throw err;
    }
  }

  async freeze(name: string, scenario: Scenario): Promise<string> {
    const path = this.pathFor(name);
    await saveSkillFile(path, scenario);
    return path;
  }
}

/** Freeze a scenario to a skill file. The file is the bare Scenario JSON, nothing wrapped. */
export async function saveSkillFile(path: string, scenario: Scenario): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(scenario, null, 2), "utf8");
}

export class InvalidSkillFileError extends Error {
  constructor(readonly path: string) {
    super(`Invalid skill file: ${path}`);
    this.name = "InvalidSkillFileError";
  }
}

export async function loadSkillFile(path: string): Promise<Scenario> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (isScenario(parsed)) return parsed;
  throw new InvalidSkillFileError(path);
}

function isScenario(value: unknown): value is Scenario {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "steps" in value &&
    "assertions" in value &&
    typeof value.name === "string" &&
    Array.isArray(value.steps) &&
    Array.isArray(value.assertions)
  );
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}
