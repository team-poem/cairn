import { afterEach, expect, it, vi } from "vitest";
import type { Scenario } from "../src/core/types.js";

const fixture = vi.hoisted(() => ({ scenario: {} as Scenario }));
vi.mock("../src/core/discover/index.js", () => ({ discover: vi.fn(async () => fixture.scenario) }));
vi.mock("../src/adapters/drivers/chrome.js", () => ({
  ChromeDevToolsDriver: class { async close(): Promise<void> {} },
}));
vi.mock("../src/adapters/llm/factory.js", () => ({ createLlmClient: vi.fn(() => ({ id: "scripted" })) }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

it.each([false, true])("CLI warns about pre-mutation navigation even with a surviving request proof (%s)", async (requestProof) => {
  fixture.scenario = {
    name: "sign in", steps: [],
    assertions: [
      { kind: "navigated", to: "shop.test/signin", origin: "derived", observedBeforeLastMutation: true },
      ...(requestProof ? [{ kind: "request-status" as const, urlIncludes: "/api/signin", method: "POST", status: 200 }] : []),
    ],
  };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const argv = process.argv;
  try {
    process.argv = ["node", "cairn", "discover", "sign in", "--url", "https://shop.test"];
    await import("../src/cli.js");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(error).not.toHaveBeenCalled();
    const output = log.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(output).toContain("already reached before the last mutation");
    expect(output).toContain("does not prove post-mutation navigation");
    expect(output).toContain("refuse this freeze");
  } finally {
    process.argv = argv;
  }
});
