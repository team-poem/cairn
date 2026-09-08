// file: packages/harness/test/cli-replay-environment.test.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { flagReplayEnvironment, parseArgs } from "../src/cli-args.js";

test("cliReplayEnvironmentFlags: paired flags preserve suite discovery base and reject unsafe freeze", () => {
  const read = (args: string[], baseFlag?: string) => flagReplayEnvironment(parseArgs(args).flags, baseFlag);
  const want = { baseUrl: "http://localhost:3000", allowedHosts: ["stage.test", "api.stage.test"] };
  expect(read(["--base-url=http://localhost:3000", "--allowed-hosts", "stage.test, api.stage.test"])).toEqual(want);
  expect(read(["--base-url", "https://canonical.test", "--replay-base-url", "http://localhost:3000", "--allowed-hosts=stage.test,api.stage.test"], "replay-base-url")).toEqual(want);
  expect(read([])).toBeUndefined(); expect(read(["--base-url=https://canonical.test"], "replay-base-url")).toBeUndefined();
  for (const args of [
    ["--base-url=http://localhost:3000"], ["--allowed-hosts=stage.test"], ["--base-url", "--allowed-hosts=stage.test"],
    ["--base-url=http://localhost:3000", "--allowed-hosts"], ["--base-url=http://localhost:3000", "--allowed-hosts="],
    ["--base-url=file:///tmp/x", "--allowed-hosts=stage.test"], ["--base-url=http://localhost:3000", "--allowed-hosts=stage.test,,api.stage.test"],
    ["--base-url=http://localhost:3000", "--allowed-hosts=stage.test", "--freeze=original.json"],
  ]) expect(() => read(args), args.join(" ")).toThrow(/base-url|allowed-hosts|freeze|baseUrl/);
});

test("cliReplayEnvironmentHelp: installed CLI documents environment flags", async () => {
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, ["--import", "tsx", "src/cli.ts", "--help"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 10_000,
  });
  expect(stdout).toContain("--allowed-hosts"); expect(stdout).toContain("--replay-base-url");
  expect(stdout).toMatch(/replay.*--base-url/); expect(stdout).toMatch(/suite.*--base-url/);
});
