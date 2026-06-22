/**
 * LlmClient backed by the local Claude Code CLI (`claude -p`).
 *
 * This is the default when no API key is present: a user who already has Claude Code
 * installed can run cairn's discover loop with no extra credentials — it reuses their
 * existing auth. Swappable for AnthropicLlmClient via `createLlmClient` (invariant #5).
 */
import { spawn } from "node:child_process";
import type { CompleteOptions, LlmClient } from "./client.js";

export interface ClaudeCodeOptions {
  /** Model alias passed to `--model` (e.g. "sonnet", "haiku"). */
  model?: string;
  /** Path to the claude binary. */
  bin?: string;
  /** Hard timeout in ms. */
  timeoutMs?: number;
}

export class ClaudeCodeLlmClient implements LlmClient {
  readonly id: string;
  private readonly model: string;
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(opts: ClaudeCodeOptions = {}) {
    this.model = opts.model ?? "sonnet";
    this.bin = opts.bin ?? "claude";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.id = `claude-code:${this.model}`;
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const args = ["-p", "--model", this.model];
    if (opts.system) args.push("--append-system-prompt", opts.system);
    const input = prompt;

    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.bin, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`claude -p timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`claude -p exited ${code}: ${stderr.trim()}`));
      });

      child.stdin.write(input);
      child.stdin.end();
    });
  }
}
