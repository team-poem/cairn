import { randomUUID } from "node:crypto";
import { errorKindOf } from "../../core/errors.js";
import { extractFirstJsonObject } from "../../core/json.js";

type Evaluate = (source: string, uids?: string[]) => Promise<string>;
function checkTerminal(error: unknown): void {
  if (errorKindOf(error) === "transport" ||
      error instanceof Error && ["BudgetExceededError", "AbortError"].includes(error.name)) throw error;
}

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
        let candidate;
        const onClick = event => {
          if (!event.isTrusted) return;
          receipt.clicks = Math.min(2, receipt.clicks + 1);
          const path = event.composedPath();
          const boundary = path.indexOf(node);
          // MCP clicks the center of the control; its label is often a span or an
          // SVG icon. Credit a native/ARIA control only through presentational
          // descendants. Another target, shadow root or nested control is unknown.
          const matches = boundary === 0 || (boundary > 0 &&
            node.matches('button,input,a[href],select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="option"],[role="menuitem"]') &&
            path.slice(0, boundary).every(el => el?.nodeType === 1 &&
              /^(span|em|strong|b|i|small|svg|g|path|use)$/i.test(el.localName) &&
              !el.matches('[role],[tabindex],[contenteditable],[onclick],[href]') && !el.onclick));
          candidate = matches ? event : undefined;
        };
        // composedPath contains ancestors even if a child listener subsequently
        // stops propagation. Require the same event to reach the selected node.
        const onTarget = event => { if (event === candidate) receipt.reached = true; };
        receipt.dispose = () => {
          clearTimeout(timer);
          candidate = undefined;
          window.removeEventListener('pagehide', receipt.dispose);
          window.removeEventListener('click', onClick, true);
          node.removeEventListener('click', onTarget);
          if (state.pending === receipt) delete state.pending;
        };
        const timer = setTimeout(receipt.dispose, 30000);
        window.addEventListener('pagehide', receipt.dispose, { once: true });
        window.addEventListener('click', onClick, { capture:true, passive:true });
        node.addEventListener('click', onTarget, { passive:true });
        state.pending = receipt;
        return { id: state.doc + ':' + id };
      }`, [uid]);
      const result = extractFirstJsonObject(reply) as {id?: unknown} | undefined;
      if (typeof result?.id === "string" && /^[0-9a-f-]{36}:[1-9]\d{0,15}$/.test(result.id)) this.identity = result.id;
    } catch (error) { checkTerminal(error); } // An unavailable optional measurement alone cannot veto the click.
  }

  beforeSend(): void { this.before?.(this.identity); }

  /** Read after an acknowledgment or after closing an informational alert for
   * a timed-out ordinary click. Other failures/vetoes admit no extra read. */
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
    } catch (error) { checkTerminal(error); } // Navigation or a missing receipt leaves identity unknown.
  }
}
