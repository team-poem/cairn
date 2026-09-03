import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Consolidated audit coverage.

{

  const run = promisify(execFile);

  const pkg = fileURLToPath(new URL("../", import.meta.url));

  const cli = async (...args: string[]) => {
    try {
      const r = await run("npx", ["tsx", "src/cli.ts", ...args], { cwd: pkg, timeout: 10_000 });
      return { code: 0, ...r };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  };

  // cli-missing-args-exit-1.test.ts
  {
    it("cliMissingArgsExit1: run/replay/discover/explore/suite without their required input exit 1 with a usage hint — before any browser or LLM", async () => {
      const cases: [string[], string][] = [
        [["run"], "--scenario"],
        [["replay"], "usage: cairn replay"],
        [["discover"], "usage: cairn discover"],
        [["explore", "charter"], "usage: cairn explore"], // no --url
        [["suite"], "usage: cairn suite"],
      ];
      for (const [args, hint] of cases) {
        const r = await cli(...args);
        expect(r.code, args.join(" ")).toBe(1);
        expect(r.stderr, args.join(" ")).toContain(hint);
      }
    }, 30_000);
  }

  // cli-unknown-command-exits-2.test.ts
  {
    it("cliUnknownCommandExits2: an unknown command exits 2 with a usage line; --version exits 0 with the engine version", async () => {
      const bad = await cli("bogus");
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain("usage: cairn");

      const v = await cli("--version");
      expect(v.code).toBe(0);
      expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    }, 20_000);
  }

}
