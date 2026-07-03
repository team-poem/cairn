/**
 * Shared test doubles for the unit suites — excluded from the published build (tsconfig.build.json).
 * `FakeDriver` (adapters/drivers/fake.ts) stays the shipped, static-evidence double; these are the
 * scriptable ones the suites previously re-declared per file.
 */
import type { Driver, LlmClient } from "../../src/core/ports.js";
import type { Evidence, PageElement, Target } from "../../src/core/types.js";

/** Replays a fixed sequence of model replies — keeps LLM-driven flows deterministic in tests. */
export class ScriptedLlm implements LlmClient {
  readonly id = "scripted";
  private i = 0;
  constructor(private readonly replies: string[]) {}
  async complete(): Promise<string> {
    return this.replies[this.i++] ?? '{"action":"done"}';
  }
}

/** A driver whose URL changes only when a click is configured to navigate (`navOn`) — lets a test
 * make a step's `expect` hold, diverge, or be healable. Subclass and override `observe`/an action
 * for request-log or async-timing behaviors. */
export class StubDriver implements Driver {
  els: PageElement[] = [];
  readonly navOn: Record<string, string> = {};
  readonly clicked: string[] = [];
  constructor(public url = "https://app/start") {}
  async goto(u: string): Promise<void> {
    this.url = u;
  }
  async click(t: Target): Promise<void> {
    this.clicked.push(t.text ?? "");
    const to = this.navOn[t.text ?? ""];
    if (to) this.url = to;
  }
  async doubleClick(): Promise<void> {}
  async hover(): Promise<void> {}
  async type(): Promise<void> {}
  async select(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async scroll(): Promise<void> {}
  async locate(t: Target): Promise<Target> {
    return t;
  }
  async screenshot(): Promise<string | undefined> {
    return undefined;
  }
  async snapshot(): Promise<PageElement[]> {
    return this.els;
  }
  async settle(): Promise<void> {}
  async observe(): Promise<Evidence> {
    return {
      execution: { actions: [], navigated: true, finalUrl: this.url, blocked: false },
      perception: {},
      logic: { requests: [], console: [] },
    };
  }
  async close(): Promise<void> {}
}
