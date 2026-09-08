// file: packages/harness/test/cli-replay-entry.test.ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
const fixture = vi.hoisted(() => ({ run: vi.fn(async () => { throw new Error("browser must not start"); }) }));
vi.mock("../src/run.js", async (original) => ({ ...await original<typeof import("../src/run.js")>(), runScenario: fixture.run }));

test("cliInvalidReplayEntryIsUsage: entry scope is checked before the run/crash boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cairn-entry-refusal-")); const file = join(dir, "skill.json");
  const argv = process.argv; const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {}); const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  try {
    await writeFile(file, JSON.stringify({ name: "wrong entry", steps: [{ kind: "goto", url: "https://production.test/start" }], assertions: [{ kind: "navigated", to: "production.test/start" }] }));
    process.argv = ["node", "cairn", "replay", file, "--base-url", "http://localhost:3000", "--allowed-hosts", "stage.test"];
    await import("../src/cli.js"); await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(2));
    expect(fixture.run).not.toHaveBeenCalled(); expect(error.mock.calls.flat().join(" ")).toMatch(/entry|allowedHosts/);
  } finally { process.argv = argv; log.mockRestore(); error.mockRestore(); exit.mockRestore(); await rm(dir, { recursive: true, force: true }); }
});
