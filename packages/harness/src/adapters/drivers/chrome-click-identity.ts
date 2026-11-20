import { randomUUID } from "node:crypto";
import { extractFirstJsonObject } from "../../core/json.js";

type Evaluate = (source: string, uids?: string[]) => Promise<string>;

/** Measure exactly one MCP node, without taking a new snapshot or changing input waiting.
 * Stable IDs are allocated in the document, not derived from the snapshot's rotating UIDs.
 * A successful tool reply alone is not a receipt: the page may have replaced or obscured
 * the node. Verify that a trusted click actually reached it before publishing its ID. */
export class ChromeClickIdentity {
  private readonly ticket = randomUUID();
  private identity?: string;
  confirmed?: string;
  constructor(private readonly evaluate: Evaluate, private readonly before?: (id: string | undefined) => void) {}

  async prepare(uid: string): Promise<void> {
    try {
      const token = JSON.stringify(this.ticket);
      const reply = await this.evaluate(`node => {
        if (!node || node.nodeType !== 1 || !node.isConnected || node.getRootNode() !== document ||
            window !== window.top) return {};
        const symbol = Symbol.for('cairn.click-outcome.v1');
        const state = document[symbol] ??= { doc: ${token}, ids: new WeakMap(), last: 0 };
        state.pending?.dispose();
        let id = state.ids.get(node);
        if (!id) {
          if (!Number.isSafeInteger(state.last + 1)) return {};
          state.ids.set(node, id = ++state.last);
        }
        const receipt = { ticket: ${token}, clicks: 0, reached: false };
        const onClick = event => {
          if (!event.isTrusted) return;
          receipt.clicks = Math.min(2, receipt.clicks + 1);
          // A click on a child can bubble through a different actionable descendant.
          // Abstain rather than identifying that click with its ancestor.
          receipt.reached = event.composedPath()[0] === node;
        };
        receipt.dispose = () => {
          clearTimeout(timer);
          window.removeEventListener('pagehide', receipt.dispose);
          window.removeEventListener('click', onClick, true);
          if (state.pending === receipt) delete state.pending;
        };
        const timer = setTimeout(receipt.dispose, 30000);
        window.addEventListener('pagehide', receipt.dispose, { once: true });
        window.addEventListener('click', onClick, { capture:true, passive:true });
        state.pending = receipt;
        return { id: state.doc + ':' + id };
      }`, [uid]);
      const result = extractFirstJsonObject(reply) as {id?: unknown} | undefined;
      if (typeof result?.id === "string" && /^[0-9a-f-]{36}:[1-9]\d{0,15}$/.test(result.id)) this.identity = result.id;
    } catch { /* This optional observation grants no authority to change or retry the input. */ }
  }

  beforeSend(): void { this.before?.(this.identity); }

  /** Call only on an acknowledged click. Vetoes and failed inputs admit no extra read;
   * their listener is removed on the next prepare, on pagehide, or on its timeout. */
  async finish(): Promise<void> {
    if (!this.identity) return;
    try {
      const reply = await this.evaluate(`() => {
        const p = document[Symbol.for('cairn.click-outcome.v1')]?.pending;
        if (!p || p.ticket !== ${JSON.stringify(this.ticket)}) return {};
        p.dispose();
        return { reached: p.clicks === 1 && p.reached === true };
      }`);
      if ((extractFirstJsonObject(reply) as {reached?: unknown} | undefined)?.reached === true)
        this.confirmed = this.identity;
    } catch { /* Navigation, a lost receipt or a missing reply leaves identity unknown. */ }
  }
}
