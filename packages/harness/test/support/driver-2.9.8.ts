import type { CollectionObservation, CollectionTarget, DestinationResourceKey, Driver, Evidence, PageElement,
  ResourceKeyObservation, SelectedItemKey, Target } from "../../src/index.js";

/** A third-party Driver written against the 2.9.8 surface, reading the fields that surface declares.
 * `npm run typecheck` compiles this file, so a port change that breaks such a driver fails there. */
export class AttributeDriver implements Driver {
  readonly calls: string[] = [];
  async goto(url: string): Promise<void> { this.calls.push(`goto:${url}`); }
  async click(target: Target, ref?: string): Promise<void> { this.calls.push(`click:${target.text}:${ref}`); }
  async doubleClick(): Promise<void> {}
  async hover(): Promise<void> {}
  async type(): Promise<void> {}
  async locate(target: Target): Promise<Target> { return target; }
  async select(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async scroll(): Promise<void> {}
  async screenshot(): Promise<string | undefined> { return undefined; }
  async snapshot(): Promise<PageElement[]> { return [{ role: "link", name: "Bravo" }]; }
  async settle(): Promise<void> {}
  async observe(): Promise<Evidence> {
    return { execution: { actions: [], navigated: false, blocked: false }, console: [], network: [], dom: { url: "https://app/posts" } } as unknown as Evidence;
  }
  async close(): Promise<void> {}
  async observeCollection(selection: CollectionTarget): Promise<CollectionObservation> {
    this.calls.push(`observe:${selection.root.role}:${selection.itemRole}:${selection.target.role}`);
    return { order: "dom", complete: true, conditions: [], items: [] };
  }
  async clickWithSelectedItemEvidence(_target: Target, ref: string, source: SelectedItemKey): Promise<ResourceKeyObservation> {
    this.calls.push(`key:${ref}:${source.scope}:${source.attribute}`);
    return { complete: false };
  }
  async readResourceKey(destination: DestinationResourceKey): Promise<ResourceKeyObservation> {
    this.calls.push(`read:${destination.selector}:${destination.attribute}`);
    return { complete: false };
  }
}
