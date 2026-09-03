import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicLlmClient } from "../../../src/adapters/llm/anthropic.js";
import { GeminiLlmClient } from "../../../src/adapters/llm/gemini.js";
import { OpenAILlmClient } from "../../../src/adapters/llm/openai.js";
import type { LlmUsage } from "../../../src/core/types.js";

const KEYS = ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];

describe("OpenAI / Gemini clients", () => {
  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it("carry their model in the id", () => {
    expect(new OpenAILlmClient({ apiKey: "k", model: "gpt-4o-mini" }).id).toBe(
      "openai:gpt-4o-mini",
    );
    expect(
      new GeminiLlmClient({ apiKey: "k", model: "gemini-1.5-pro" }).id,
    ).toBe("gemini:gemini-1.5-pro");
  });

  it("require an API key", () => {
    expect(() => new OpenAILlmClient()).toThrow(/OPENAI_API_KEY/);
    expect(() => new GeminiLlmClient()).toThrow(/GEMINI_API_KEY/);
  });

  it("Gemini accepts GOOGLE_API_KEY too", () => {
    process.env.GOOGLE_API_KEY = "g";
    expect(new GeminiLlmClient().id.startsWith("gemini:")).toBe(true);
  });
});

describe("usage reporting (#100) — each provider's response maps to onUsage", () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (json: unknown) =>
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(json), { status: 200 }));

  it("Anthropic: usage.{input,output,cache_read_input}_tokens", async () => {
    respond({
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 120, output_tokens: 8, cache_read_input_tokens: 100 },
    });
    let usage: LlmUsage | undefined;
    await new AnthropicLlmClient({ apiKey: "k" }).complete("p", { onUsage: (u) => (usage = u) });
    expect(usage).toEqual({ inputTokens: 120, outputTokens: 8, cacheReadTokens: 100 });
  });

  it("OpenAI: usage.prompt/completion_tokens (+cached)", async () => {
    respond({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 30 } },
    });
    let usage: LlmUsage | undefined;
    await new OpenAILlmClient({ apiKey: "k" }).complete("p", { onUsage: (u) => (usage = u) });
    expect(usage).toEqual({ inputTokens: 50, outputTokens: 5, cacheReadTokens: 30 });
  });

  it("Gemini: usageMetadata token counts", async () => {
    respond({
      candidates: [{ content: { parts: [{ text: "hi" }] } }],
      usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 4 },
    });
    let usage: LlmUsage | undefined;
    await new GeminiLlmClient({ apiKey: "k" }).complete("p", { onUsage: (u) => (usage = u) });
    expect(usage).toEqual({ inputTokens: 40, outputTokens: 4, cacheReadTokens: undefined });
  });

  it("stays silent when the response carries no usage", async () => {
    respond({ content: [{ type: "text", text: "hi" }] });
    let called = false;
    await new AnthropicLlmClient({ apiKey: "k" }).complete("p", { onUsage: () => (called = true) });
    expect(called).toBe(false);
  });
});

import { EventEmitter } from "node:events";
import { readFile, stat, writeFile } from "node:fs/promises";
import { ClaudeCodeLlmClient } from "../../../src/adapters/llm/claude-code.js";
import { CodexLlmClient } from "../../../src/adapters/llm/codex.js";

const cp = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: cp.spawn }));

// Consolidated audit coverage.

describe("subprocess client audit coverage", () => {

  /** A scripted child process: the test drives its events; stdin writes are recorded. */
  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: vi.fn(), end: vi.fn() };
    child.kill = vi.fn();
    return child;
  }

  beforeEach(() => {
    cp.spawn.mockReset();
  });

  // claude-code-kills-on-timeout.test.ts
  {
    describe("ClaudeCodeLlmClient subprocess", () => {
      it("claudeCodeKillsOnTimeout: past timeoutMs the child gets SIGKILL and the call rejects with the timeout message", async () => {
        const child = fakeChild();
        cp.spawn.mockReturnValue(child);
        const p = new ClaudeCodeLlmClient({ timeoutMs: 10 }).complete("x");
        await expect(p).rejects.toThrow("claude -p timed out after 10ms");
        expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      });
    });
  }

  // claude-code-rejects-on-spawn-error.test.ts
  {
    describe("ClaudeCodeLlmClient subprocess", () => {
      it("claudeCodeRejectsOnSpawnError: a spawn `error` event (binary missing) rejects with that error and clears the timer", async () => {
        const child = fakeChild();
        cp.spawn.mockReturnValue(child);
        const p = new ClaudeCodeLlmClient({ bin: "nope", timeoutMs: 50 }).complete("x");
        child.emit("error", new Error("spawn nope ENOENT"));
        await expect(p).rejects.toThrow("spawn nope ENOENT");
        await new Promise((r) => setTimeout(r, 70));
        expect(child.kill).not.toHaveBeenCalled(); // timer was cleared, no late SIGKILL
      });
    });
  }

  // claude-code-rejects-with-exit-code-and-stderr.test.ts
  {
    describe("ClaudeCodeLlmClient subprocess", () => {
      it("claudeCodeRejectsWithExitCodeAndStderr: a non-zero exit rejects `claude -p exited <code>: <stderr>`", async () => {
        const child = fakeChild();
        cp.spawn.mockReturnValue(child);
        const p = new ClaudeCodeLlmClient().complete("x");
        child.stderr.emit("data", "not logged in\n");
        child.emit("close", 1);
        await expect(p).rejects.toThrow("claude -p exited 1: not logged in");
      });
    });
  }

  // claude-code-resolves-trimmed-stdout-and-pipes-prompt.test.ts
  {
    describe("ClaudeCodeLlmClient subprocess", () => {
      it("claudeCodeResolvesTrimmedStdoutAndPipesPrompt: `claude -p --model <m> --append-system-prompt <s>` gets the prompt on stdin and resolves trimmed stdout on exit 0", async () => {
        const child = fakeChild();
        cp.spawn.mockReturnValue(child);
        const p = new ClaudeCodeLlmClient({ model: "opus" }).complete("hello?", { system: "be terse" });
        expect(cp.spawn).toHaveBeenCalledWith(
          "claude",
          ["-p", "--model", "opus", "--append-system-prompt", "be terse"],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        expect(child.stdin.write).toHaveBeenCalledWith("hello?");
        expect(child.stdin.end).toHaveBeenCalled();
        child.stdout.emit("data", "  answer\n");
        child.emit("close", 0);
        expect(await p).toBe("answer");
      });
    });
  }

  // codex-cleans-up-temp-dir-on-failure.test.ts
  {
    describe("CodexLlmClient subprocess", () => {
      it("codexCleansUpTempDirOnFailure: a non-zero exit rejects `codex exec exited <code>: <stderr>` and the temp dir is still removed", async () => {
        const child = fakeChild();
        let outFile = "";
        cp.spawn.mockImplementation((_bin: string, args: string[]) => {
          outFile = args[args.indexOf("-o") + 1]!;
          queueMicrotask(() => {
            child.stderr.emit("data", "auth required");
            child.emit("close", 2);
          });
          return child;
        });
        await expect(new CodexLlmClient().complete("q")).rejects.toThrow("codex exec exited 2: auth required");
        expect(child.stdin.write).toHaveBeenCalledWith("q"); // no system → prompt passes through untouched
        await expect(stat(outFile.replace(/\/[^/]+$/, ""))).rejects.toThrow();
      });
    });
  }

  // codex-kills-on-timeout-and-rejects-on-spawn-error.test.ts
  {
    describe("CodexLlmClient subprocess", () => {
      it("codexKillsOnTimeoutAndRejectsOnSpawnError: timeout → SIGKILL + timeout message; a spawn error rejects with it", async () => {
        const slow = fakeChild();
        cp.spawn.mockReturnValue(slow);
        await expect(new CodexLlmClient({ timeoutMs: 10 }).complete("q")).rejects.toThrow("codex exec timed out after 10ms");
        expect(slow.kill).toHaveBeenCalledWith("SIGKILL");

        const broken = fakeChild();
        cp.spawn.mockImplementation(() => {
          queueMicrotask(() => broken.emit("error", new Error("spawn codex ENOENT")));
          return broken;
        });
        await expect(new CodexLlmClient().complete("q")).rejects.toThrow("spawn codex ENOENT");
      });
    });
  }

  // codex-reads-answer-from-output-file-and-removes-temp-dir.test.ts
  {
    describe("CodexLlmClient subprocess", () => {
      it("codexReadsAnswerFromOutputFileAndRemovesTempDir: the reply comes from the `-o <file>` path, system prompt is inlined on stdin, temp dir is gone afterwards", async () => {
        const child = fakeChild();
        let outFile = "";
        cp.spawn.mockImplementation((_bin: string, args: string[]) => {
          outFile = args[args.indexOf("-o") + 1]!;
          queueMicrotask(async () => {
            await writeFile(outFile, "  the answer \n", "utf8");
            child.emit("close", 0);
          });
          return child;
        });
        const reply = await new CodexLlmClient({ model: "gpt-5.5" }).complete("q?", { system: "sys" });
        expect(reply).toBe("the answer");
        const [bin, args, opts] = cp.spawn.mock.calls[0] as [string, string[], unknown];
        expect(bin).toBe("codex");
        expect(args.slice(0, 9)).toEqual(["exec", "--skip-git-repo-check", "--ignore-user-config", "--ephemeral", "--sandbox", "read-only", "--color", "never", "-o"]);
        expect(args.slice(10)).toEqual(["-m", "gpt-5.5"]);
        expect(opts).toEqual({ stdio: ["pipe", "ignore", "pipe"] });
        expect(child.stdin.write).toHaveBeenCalledWith("<system>\nsys\n</system>\n\nq?");
        await expect(stat(outFile)).rejects.toThrow(); // temp dir removed in finally
      });
    });
  }

});
