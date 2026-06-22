/**
 * In-memory Driver for tests — no browser. Lets the deterministic pipeline (Plan →
 * Execute → Judge → Report) be unit-tested without the real Chrome MCP backend, and
 * proves the core is driver-agnostic (invariant #5).
 */
import type { Driver } from "../interfaces.js";
import type { Evidence, Target } from "../types.js";

export interface FakeScript {
  /** Evidence the fake returns from observe(). */
  evidence: Evidence;
  /** Targets that should throw when acted on (by text), to simulate failures. */
  failOn?: string[];
}

export class FakeDriver implements Driver {
  closed = false;
  readonly visited: string[] = [];
  readonly clicked: Target[] = [];

  constructor(private readonly script: FakeScript) {}

  async goto(url: string): Promise<void> {
    this.visited.push(url);
  }

  async click(target: Target): Promise<void> {
    if (target.text && this.script.failOn?.includes(target.text)) {
      throw new Error(`element not found: ${target.text}`);
    }
    this.clicked.push(target);
  }

  async type(target: Target, _text: string): Promise<void> {
    if (target.text && this.script.failOn?.includes(target.text)) {
      throw new Error(`element not found: ${target.text}`);
    }
  }

  async observe(): Promise<Evidence> {
    return this.script.evidence;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
