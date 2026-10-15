/**
 * LlmClient backed by the local Claude Code CLI (`claude -p`) — the default when no API key
 * is set: it reuses an installed Claude Code's auth, no extra credentials. Swappable for
 * AnthropicLlmClient via `createLlmClient` (invariant #5).
 */
import { spawn } from "node:child_process";
import type { CompleteOptions, LlmClient } from "../../core/ports.js";

export interface ClaudeCodeOptions {
  model?: string;
  bin?: string;
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
    opts.signal?.throwIfAborted();
    const args = ["-p", "--model", this.model];
    if (opts.system) args.push("--append-system-prompt", opts.system);

    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.bin, args, { stdio: ["pipe", "pipe", "pipe"] });
      const abort = () => { child.kill("SIGKILL"); };
      opts.signal?.addEventListener("abort", abort, { once: true });
      child.stdin.on("error", () => {}); // cancellation can close stdin before the write drains
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`claude -p timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => {
        opts.signal?.removeEventListener("abort", abort);
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        opts.signal?.removeEventListener("abort", abort);
        clearTimeout(timer);
        if (opts.signal?.aborted) reject(opts.signal.reason);
        else if (code === 0) resolve(stdout.trim());
        else reject(new Error(`claude -p exited ${code}: ${stderr.trim()}`));
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
