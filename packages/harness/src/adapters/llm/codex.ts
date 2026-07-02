/**
 * LlmClient backed by the OpenAI Codex CLI (`codex exec`) — a third-party CLI backend that
 * reuses an installed Codex's ChatGPT login, no API key. Sibling of ClaudeCodeLlmClient;
 * swappable via `createLlmClient` (invariant #5).
 *
 * The run is hermetic: `--ignore-user-config` (no user hooks/plugins/notify side effects),
 * `--sandbox read-only` + `--ephemeral` (a completion call must not execute commands or
 * persist sessions), and `-o <file>` so the answer is read from a file instead of scraping
 * the human-oriented stdout log.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompleteOptions, LlmClient } from "../../core/ports.js";

export interface CodexOptions {
  /** Model passed as `codex exec -m`. The default must be a ChatGPT-plan model — with
   * `--ignore-user-config` the CLI's own default (a `-codex` variant) is API-only. */
  model?: string;
  bin?: string;
  timeoutMs?: number;
}

export class CodexLlmClient implements LlmClient {
  readonly id: string;
  private readonly model: string;
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(opts: CodexOptions = {}) {
    this.model = opts.model ?? "gpt-5.5";
    this.bin = opts.bin ?? "codex";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.id = `codex:${this.model}`;
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    // codex exec has no system-prompt flag; carry it as a labelled block in the prompt.
    const input = opts.system ? `<system>\n${opts.system}\n</system>\n\n${prompt}` : prompt;

    const dir = await mkdtemp(join(tmpdir(), "cairn-codex-"));
    const outFile = join(dir, "last-message.txt");
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "-o",
      outFile,
      "-m",
      this.model,
    ];

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.bin, args, { stdio: ["pipe", "ignore", "pipe"] });
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`codex exec timed out after ${this.timeoutMs}ms`));
        }, this.timeoutMs);

        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`codex exec exited ${code}: ${stderr.trim()}`));
        });

        child.stdin.write(input);
        child.stdin.end();
      });
      return (await readFile(outFile, "utf8")).trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
