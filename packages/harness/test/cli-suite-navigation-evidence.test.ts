import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SuiteOptions, SuiteResult } from "../src/suite.js";

const fixture = vi.hoisted(() => ({ suite: {} as SuiteResult }));
vi.mock("../src/suite.js", () => ({
  runSuite: vi.fn(async (_cases: unknown, options: SuiteOptions) => {
    fixture.suite.verdicts.forEach((verdict) => options.onCase?.(verdict));
    return fixture.suite;
  }),
}));

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

it.each([true, false])("suite CLI progress, report and JSON retain the optional navigation advisory (%s)", async (marked) => {
  const usage = { llmCalls: 0, measuredCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  fixture.suite = {
    passed: true, usage,
    verdicts: [{
      id: "save", intent: "save form", skillRef: "skills/save.skill.json", discovered: false,
      heals: 0, usage, verdict: { passed: true, results: [] },
      ...(marked ? { observedBeforeLastMutation: ["shop/form"] } : {}),
    }],
  };
  const dir = await mkdtemp(join(tmpdir(), "cairn-cli-navigation-"));
  const cases = join(dir, "cases.json");
  const report = join(dir, "report.md");
  const json = join(dir, "result.json");
  await writeFile(cases, JSON.stringify([{ id: "save", intent: "save form", url: "https://shop/start" }]));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const argv = process.argv;
  try {
    process.argv = ["node", "cairn", "suite", cases, "--report", report, "--json", json];
    await import("../src/cli.js");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(error).not.toHaveBeenCalled();
    const output = log.mock.calls.map((args) => args.join(" ")).join("\n");
    const markdown = await readFile(report, "utf8");
    const result = JSON.parse(await readFile(json, "utf8")) as SuiteResult;
    expect(result).toEqual(fixture.suite);
    if (marked) {
      expect(output).toContain("destination observed before last mutation: shop/form (advisory)");
      expect(markdown).toContain("destination observed before last mutation: shop/form (advisory)");
    } else {
      expect(output).not.toContain("destination observed before last mutation");
      expect(markdown).not.toContain("destination observed before last mutation");
    }
  } finally {
    process.argv = argv;
    await rm(dir, { recursive: true, force: true });
  }
});
