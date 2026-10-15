import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { appContextFromFlags } from "../src/cli-app-context.js";
import { discover, hashContractValue, MAX_APP_CONTEXT_BYTES } from "../src/index.js";
import { StubDriver } from "./support/doubles.js";
import { parseArgs } from "../src/cli-args.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function file(contents: string | Uint8Array) {
  const dir = await mkdtemp(join(tmpdir(), "cairn-context-")); dirs.push(dir);
  const path = join(dir, "app.txt"); await writeFile(path, contents); return path;
}
it("loads only an explicitly named local file", async () => {
  expect(await appContextFromFlags(new Map())).toBeUndefined();
  const path = await file("  reusable app knowledge\n");
  const { flags } = parseArgs(["--app-context", path]);
  const text = await appContextFromFlags(flags);
  await writeFile(path, "new content");
  expect(text).toBe("  reusable app knowledge\n"); // Normalize only after the engine slots secrets.
  expect(await appContextFromFlags(flags)).toBe("new content");
});

it.each([
  { text: " secret-fragment enables access", token: " secret-fragment", expected: "{token} enables access" },
  { text: "Access uses secret-fragment ", token: "secret-fragment ", expected: "Access uses {token}" },
  { text: "\ufeffsecret-fragment", token: "\ufeffsecret-fragment", expected: "{token}" },
])("preserves file whitespace until engine secret substitution ($expected)", async ({ text, token, expected }) => {
  const path = await file(text);
  const appContext = await appContextFromFlags(new Map([["app-context", path]]));
  expect(appContext).toBe(text);
  const prompts: string[] = [];
  const llm = { id: "scripted", complete: async (prompt: string) => {
    prompts.push(prompt); return prompts.length === 1 ? '{"action":"done"}' : "[]";
  } };
  const frozen = await discover("Open cart", { driver: new StubDriver(), llm, appContext, secrets: { token } });
  expect(prompts).toHaveLength(2);
  for (const prompt of prompts) {
    expect(prompt).toContain(JSON.stringify(expected));
    expect(prompt).not.toContain("secret-fragment");
  }
  expect(frozen.provenance?.appContextHash).toBe(await hashContractValue(expected));
});
it("accepts empty input but rejects missing values, oversized files and invalid UTF-8", async () => {
  await expect(appContextFromFlags(new Map([["app-context", true]]))).rejects.toThrow("file path");
  const blank = await file(" \n");
  expect(await appContextFromFlags(new Map([["app-context", blank]]))).toBeUndefined();
  const large = await file("x".repeat(MAX_APP_CONTEXT_BYTES + 1));
  await expect(appContextFromFlags(new Map([["app-context", large]]))).rejects.toThrow("UTF-8 bytes");
  const invalid = await file(new Uint8Array([0xc3, 0x28]));
  await expect(appContextFromFlags(new Map([["app-context", invalid]]))).rejects.toThrow("valid UTF-8");
});

it("rejects a directory instead of reading it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cairn-context-")); dirs.push(dir);
  await expect(appContextFromFlags(new Map([["app-context", dir]]))).rejects.toThrow();
});

it.skipIf(process.platform === "win32").each([false, true])("rejects a FIFO without waiting for a writer (symlink: %s)", async linked => {
  const dir = await mkdtemp(join(tmpdir(), "cairn-context-")); dirs.push(dir);
  const fifo = join(dir, "app.pipe");
  const execute = promisify(execFile);
  await execute("mkfifo", [fifo]);
  const path = linked ? join(dir, "app-link") : fifo;
  if (linked) await symlink(fifo, path);
  // A timeout kills the child even if open() regresses to blocking; never wedge the test runner.
  const result = await execute(process.execPath, ["--import", "tsx", "src/cli.ts", "discover", "task",
    "--url", "https://unused.test", "--app-context", path], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 5_000, killSignal: "SIGKILL",
  }).then(() => ({ code: 0, stderr: "", killed: false }), err => err as { code: number; stderr: string; killed: boolean });
  expect(result.killed).toBe(false);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("requires a regular file");
}, 10_000);
