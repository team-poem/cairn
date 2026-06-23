/** In-memory Driver for tests (no browser); also proves the core is driver-agnostic (invariant #5). */
import type { Driver } from "../../core/ports.js";
import type { Evidence, PageElement, Target } from "../../core/types.js";

export interface FakeScript {
  evidence: Evidence;
  elements?: PageElement[];
  /** Targets (by text) that should throw when acted on, to simulate a broken step. */
  failOn?: string[];
}

export class FakeDriver implements Driver {
  closed = false;
  settled = false;
  readonly visited: string[] = [];
  readonly clicked: Target[] = [];
  readonly hovered: Target[] = [];
  readonly keys: string[] = [];
  readonly scrolls: string[] = [];

  constructor(private readonly script: FakeScript) {}

  /** Throws if the target is in `failOn`, simulating an unresolvable element. */
  private resolve(target: Target): void {
    if (target.text && this.script.failOn?.includes(target.text)) {
      throw new Error(`element not found: ${target.text}`);
    }
  }

  async goto(url: string): Promise<void> {
    this.visited.push(url);
  }

  async click(target: Target): Promise<void> {
    this.resolve(target);
    this.clicked.push(target);
  }

  async doubleClick(target: Target): Promise<void> {
    this.resolve(target);
    this.clicked.push(target);
  }

  async hover(target: Target): Promise<void> {
    this.resolve(target);
    this.hovered.push(target);
  }

  async type(target: Target, _text: string): Promise<void> {
    this.resolve(target);
  }

  async select(target: Target, _value: string): Promise<void> {
    this.resolve(target);
  }

  async pressKey(key: string): Promise<void> {
    this.keys.push(key);
  }

  async scroll(direction: "down" | "up" = "down"): Promise<void> {
    this.scrolls.push(direction);
  }

  async snapshot(): Promise<PageElement[]> {
    return this.script.elements ?? [];
  }

  async settle(): Promise<void> {
    this.settled = true;
  }

  async observe(): Promise<Evidence> {
    return this.script.evidence;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
