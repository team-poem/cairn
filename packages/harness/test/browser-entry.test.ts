import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Consolidated audit coverage.

{

  // browser-entry-node-free.test.ts
  {
    const srcDir = fileURLToPath(new URL("../src/", import.meta.url));

    /** Transitive relative-import closure of one entry file (static `from "…"` specifiers only). */
    async function closure(entry: string): Promise<Map<string, string[]>> {
      const seen = new Map<string, string[]>();
      const queue = [entry];
      while (queue.length) {
        const file = queue.shift()!;
        if (seen.has(file)) continue;
        const text = await readFile(file, "utf8");
        const specs = [...text.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((m) => m[1]!);
        seen.set(file, specs);
        for (const s of specs) if (s.startsWith(".")) queue.push(normalize(join(dirname(file), s.replace(/\.js$/, ".ts"))));
      }
      return seen;
    }

    it("browserEntryNodeFree: src/browser.ts and everything it reaches import no node: builtins and no Node-only adapter (chrome driver, claude-code/codex subprocess LLMs, fs store/sinks)", async () => {
      const graph = await closure(join(srcDir, "browser.ts"));
      const offenders: string[] = [];
      for (const [file, specs] of graph) {
        for (const s of specs) {
          if (s.startsWith("node:") || /^(fs|path|os|child_process|crypto|module|util|url|stream)$/.test(s)) offenders.push(`${file} -> ${s}`);
          if (/drivers\/chrome|llm\/(claude-code|codex)|skills\/file-store|sinks\/jsonl|reporters\/(json|suite)|\.\.\/run\.js|\.\.\/suite\.js|\.\.\/version\.js/.test(s)) offenders.push(`${file} -> ${s}`);
        }
      }
      expect(offenders).toEqual([]);
      expect(graph.size).toBeGreaterThan(10); // the walk really reached the core
    });
  }

}
