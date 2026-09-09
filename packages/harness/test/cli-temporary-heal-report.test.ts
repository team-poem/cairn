// file: packages/harness/test/cli-temporary-heal-report.test.ts
import { afterEach, expect, test, vi } from "vitest";
import type { Result, Scenario } from "../src/core/types.js";
import type { RunScenarioOptions } from "../src/run.js";

const fixture = vi.hoisted(() => ({ scenario: {} as Scenario, initial: {} as Result, final: {} as Result }));
vi.mock("../src/run.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/run.js")>();
  return { ...original, runScenario: vi.fn(async (_scenario: Scenario, options: RunScenarioOptions) => {
    await options.reporter?.emit(fixture.initial);
    return { result: fixture.final, heals: [], stepHeals: [] };
  }) };
});
vi.mock("../src/adapters/skills/file-store.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/adapters/skills/file-store.js")>();
  return { ...original, FileSkillStore: class {
    async load(): Promise<Scenario> { return fixture.scenario; }
    async freeze(): Promise<string> { throw new Error("temporary repair must not freeze"); }
  } };
});
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

test("cliTemporaryHealWithoutArtifact: final pass is printed when no healedScenario is returned", async () => {
  const assertion = { kind: "navigated" as const, to: "localhost:3000/done" };
  fixture.scenario = { name: "checkout", steps: [], assertions: [assertion] };
  fixture.initial = {
    scenario: "checkout", context: { intent: "checkout" },
    evidence: { execution: { actions: [], navigated: true, finalUrl: "http://localhost:3000/start", blocked: false }, perception: {}, logic: { requests: [], console: [] } },
    verdict: { passed: false, results: [{ assertion, passed: false, detail: "destination was not reached" }] },
  };
  fixture.final = { ...fixture.initial,
    evidence: { ...fixture.initial.evidence, execution: { ...fixture.initial.evidence.execution, finalUrl: "http://localhost:3000/done" } },
    verdict: { passed: true, results: [{ assertion, passed: true }] },
  };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const argv = process.argv;
  try {
    process.argv = ["node", "cairn", "replay", "fixture.skill.json", "--heal", "--base-url", "http://localhost:3000", "--allowed-hosts", "stage.test"];
    await import("../src/cli.js");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(error).not.toHaveBeenCalled();
    const output = log.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(output).toMatch(/✓ pass/);
    expect(output.lastIndexOf("✓ pass")).toBeGreaterThan(output.indexOf("destination was not reached"));
  } finally {
    process.argv = argv;
  }
});
