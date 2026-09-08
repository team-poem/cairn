// file: packages/harness/test/cli-temporary-heal-integration.test.ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Result, Scenario } from "../src/core/types.js";

vi.mock("../src/adapters/drivers/chrome.js", async () => {
  const { StubDriver } = await import("./support/doubles.js");
  return { ChromeDevToolsDriver: class extends StubDriver {
    constructor() {
      super();
      this.navOn.Finish = "http://localhost:3000/done";
      this.els = [{ role: "button", name: "Finish" }];
    }
  } };
});
vi.mock("../src/adapters/llm/factory.js", async () => {
  const { ScriptedLlm } = await import("./support/doubles.js");
  return { createLlmClient: vi.fn(() => new ScriptedLlm([
    '{"action":"click","text":"Finish"}', '{"action":"done"}', '[]',
  ])) };
});
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

test("cliTemporaryHealFinalResult: successful temporary outcome heal is visible in console and JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cairn-cli-temporary-heal-"));
  const file = join(dir, "checkout.skill.json");
  const json = join(dir, "result.json");
  const scenario: Scenario = { name: "checkout", steps: [{ kind: "goto", url: "https://stage.test/start" }],
    assertions: [{ kind: "navigated", to: "stage.test/done" }] };
  const original = JSON.stringify(scenario);
  await writeFile(file, original);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const argv = process.argv;
  try {
    process.argv = ["node", "cairn", "replay", file, "--heal", "--base-url", "http://localhost:3000", "--allowed-hosts", "stage.test", "--json", json];
    await import("../src/cli.js");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(error).not.toHaveBeenCalled();
    const output = log.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(output).toMatch(/✓ pass/);
    const final = JSON.parse(await readFile(json, "utf8")) as Result;
    expect(final.verdict.passed).toBe(true);
    expect(final.evidence.execution.finalUrl).toBe("http://localhost:3000/done");
    expect(final.usage?.llmCalls).toBeGreaterThan(0);
    expect(await readFile(file, "utf8")).toBe(original);
  } finally {
    process.argv = argv;
    await rm(dir, { recursive: true, force: true });
  }
});
