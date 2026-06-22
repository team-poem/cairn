/** Structured Reporter — writes the full result as JSON for CI consumption. */
import { writeFile } from "node:fs/promises";
import type { Reporter } from "../interfaces.js";
import type { Result } from "../types.js";

export class JsonReporter implements Reporter {
  constructor(private readonly path: string) {}

  async emit(result: Result): Promise<void> {
    await writeFile(this.path, JSON.stringify(result, null, 2), "utf8");
  }
}
