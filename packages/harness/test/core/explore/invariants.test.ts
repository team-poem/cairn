import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = (rel: string): string =>
  fileURLToPath(new URL(`../../../src/${rel}`, import.meta.url));

/** Invariant #4 guard: explore is a discovery-side capability — the deterministic replay path
 * must never grow a dependency on it. */
describe("explore stays off the replay path", () => {
  it.each(["core/pipeline.ts", "run.ts", "core/steps.ts", "adapters/critics/assertion.ts"])(
    "%s does not import core/explore",
    async (file) => {
      const text = await readFile(src(file), "utf8");
      expect(text).not.toMatch(/from\s+["'].*\/explore\//);
    },
  );
});
