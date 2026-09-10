/**
 * Default Driver — drives a real browser via the Chrome DevTools MCP server, which this
 * embeds as a client and spawns over stdio (so `cairn run` is self-contained). Everything
 * Chrome-specific, including parsing the MCP's human-readable text, stays here behind the
 * Driver port (invariant #5).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { extractFirstJsonArray, extractFirstJsonObject } from "../../core/json.js";
import { errorKindOf, stepError } from "../../core/errors.js";
import { promotedClickableNames } from "../../core/perception.js";
import type { Driver } from "../../core/ports.js";
import type {
  ConsoleMessage,
  Evidence,
  NetworkRequest,
  PageElement,
  SnapshotOptions,
  SettleOptions,
  Target,
} from "../../core/types.js";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const MCP_COMMAND = "npx";
// Pinned to the tested 1.3.x line: the parsers below depend on chrome-devtools-mcp's text
// format, so an unbounded `@latest` could break them silently. Override via ChromeDriverOptions.
// `--isolated` gives the harness its own ephemeral browser, so a standalone `cairn run`
// never collides with another chrome-devtools-mcp using the default profile.
const MCP_ARGS = ["-y", "chrome-devtools-mcp@~1.3.0", "--isolated"];

// Target resolution retries — a late-rendering element (SPA hydration, a just-opened panel) may not
// be in the snapshot on the first look. Retry briefly before failing, so replay doesn't miss it and
// fall to self-heal for a purely timing gap. Zero cost when the element is already present.
const RESOLVE_RETRIES = 3;
const RESOLVE_RETRY_MS = 300;

// A custom dropdown's options render into a portal AFTER it opens — bounded wait for them.
const OPTION_WAIT_MS = 2_000;
const OPTION_POLL_MS = 150;
let nextDriverId = 0;

// A roleless clickable region (a card that's a div + cursor:pointer, not a native/ARIA control) is
// invisible to a11y-based perception: the model can't target it and gets drawn to a name-matching
// nav link instead. Promote the label of such a region to a clickable — universally, no framework
// assumptions: cursor:pointer AND an inline/property click handler on a roleless, non-native ancestor.
// Requiring the handler both removes false positives (a pointer-styled decoration) and de-nests for
// free (the handler sits on the region root, not the inner text). Handlers attached another way —
// React delegates onClick at the root, invisible to the DOM — are app/framework knowledge, so a
// consumer driver's job (invariant #1), not this reference driver's. Capped so a busy page can't flood.
const CLICKABLE_HOPS = 6;
/** For each passed element, the id of its nearest roleless `cursor:pointer` ancestor (a clickable
 * region), or -1 — so the driver keeps one label per region (de-nesting). Framework-agnostic. */
const CLICKABLE_PROBE =
  "(...els) => { const seen = new Map(); let next = 0; return els.map((el) => {" +
  " let n = el && el.nodeType === 3 ? el.parentElement : el; let hops = 0;" +
  " while (n && hops++ < " + CLICKABLE_HOPS + ") {" +
  " const cs = getComputedStyle(n);" +
  " const handler = typeof n.onclick === 'function' || n.hasAttribute('onclick');" +
  " if (cs.cursor === 'pointer' && handler && !n.getAttribute('role') &&" +
  " !/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|LABEL|DETAILS|OPTION)$/.test(n.tagName)) {" +
  " if (!seen.has(n)) seen.set(n, next++); return seen.get(n); }" +
  " n = n.parentElement; } return -1; }); }";

/** Facts are keyed by the exact MCP node, never by its accessible name. The DOM supplies
 * geometry/ARIA/cursor facts only; core owns de-nesting, promotion quotas, and ranking.
 * A clipped, offscreen, zero-size, or shadow-tree hit test is unknown, not positive occlusion. */
export function perceptionProbeScript(uids: readonly string[], clickables = true, registry?: string, guard?: string): string {
  return String.raw`(...els) => {
    const ids = ${JSON.stringify(uids)};
    const registry = ${JSON.stringify(registry ?? null)};
    const regions = registry
      ? (globalThis[Symbol.for(registry)] ??= new WeakMap()) : new Map();
    const active = new Set();
    const visible = (el) => {
      const style = getComputedStyle(el);
      return el.getClientRects().length > 0 && style.display !== "none" &&
        style.visibility !== "hidden" && el.getAttribute("aria-hidden") !== "true";
    };
    for (const control of document.querySelectorAll('[aria-expanded="true"]')) {
      for (const attr of ["aria-controls", "aria-owns"]) {
        for (const id of (control.getAttribute(attr) || "").split(/\s+/)) {
          const popup = id && document.getElementById(id);
          if (popup && visible(popup) && visible(control)) active.add(popup);
        }
      }
    }
    for (const popup of document.querySelectorAll('dialog[open]')) if (visible(popup)) active.add(popup);
    try {
      for (const popup of document.querySelectorAll(':popover-open')) if (visible(popup)) active.add(popup);
    } catch { /* Older browsers need no popover selector to report ARIA-controlled popups. */ }
    const clipped = (el, x, y) => {
      for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        const style = getComputedStyle(p);
        if (!/(auto|scroll|overlay|hidden|clip)/.test(style.overflowX + " " + style.overflowY)) continue;
        const box = p.getBoundingClientRect();
        if (x < box.left || x > box.right || y < box.top || y > box.bottom) return true;
      }
      return false;
    };
    return Object.fromEntries(els.map((raw, i) => {
      const el = raw && raw.nodeType === 3 ? raw.parentElement : raw;
      const facts = {};
      if (${JSON.stringify(guard ?? null)}) {
        // RootWebArea resolves to Document in MCP. It is covered by this observer too.
        facts.referenceReady = !!el && el.isConnected && el.getRootNode() === document &&
          !!globalThis[Symbol.for(${JSON.stringify(guard ?? "")})]?.observer;
      }
      if (!el || el.nodeType !== 1 || !el.isConnected) return [ids[i], facts];
      if ([...active].some(root => root === el || root.contains(el))) facts.inActivePopup = true;
      const box = el.getBoundingClientRect();
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      if (el.getRootNode() === document && box.width && box.height &&
          x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && !clipped(el, x, y)) {
        const top = document.elementFromPoint(x, y);
        if (top) facts.occluded = top !== el && !el.contains(top);
      }
      if (${clickables}) {
        let elAt = el;
        let region;
        for (let hops = 0; elAt && hops < ${CLICKABLE_HOPS}; hops++, elAt = elAt.parentElement) {
          if (/^(button|link|checkbox|radio|switch|combobox|option|menuitem|tab|textbox)$/.test(elAt.getAttribute("role") || "") ||
              /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|LABEL|DETAILS|OPTION)$/.test(elAt.tagName)) {
            region = undefined; break;
          }
          if (elAt.getAttribute("role")) break;
          if (getComputedStyle(elAt).cursor !== "pointer") break;
          region = elAt;
        }
        if (region) {
          if (!regions.has(region)) regions.set(region, ids[i]);
          facts.clickable = true;
          facts.clickableRegion = regions.get(region);
        }
      }
      return [ids[i], facts];
    }));
  }`;
}

export interface ChromeDriverOptions {
  command?: string;
  args?: string[];
  /** Per-MCP-call timeout (ms). A hung tool call rejects instead of wedging the run. Default 30s. */
  timeoutMs?: number;
  /** Timeout for the initial browser launch/connect (ms). Default 60s (first run may download). */
  connectTimeoutMs?: number;
  /** Surface roleless `cursor:pointer` regions as clickable controls in the listing (#132). Default on;
   * set false to see only the raw a11y tree. */
  promoteClickables?: boolean;
}

/**
 * The error a failed MCP tool call becomes. The tool envelope wraps a dead transport and a
 * disabled button alike, so only this driver's own vocabulary decides `transport` (#212):
 * puppeteer's closed-target phrasing, the launch failures the first lazy call surfaces, and
 * network-level tokens — each anchored to its full phrase, because the envelope also carries page
 * text (an open dialog's message is prepended to every error while it is open). Anything else
 * stays untyped and reads as the page's, not the machine's.
 */
export function mcpToolError(name: string, text: string): Error {
  // A JS dialog blocking the action is the page's doing, not the machine's: the connection is
  // healthy, and MCP repeats the dialog's own (page-provided) text inside the error line, so it is
  // recognised BEFORE any transport phrase is looked for. `callAccepting` handles it; a verb that
  // does not accept dialogs (hover) surfaces it untyped.
  if (isDialogBlocked(text)) return new Error(`MCP ${name} failed: ${text}`);
  const transport =
    /Protocol error \([^)]*\): (?:Target closed|Session closed)|Session closed\. Most likely|Connection closed\. Most likely|chrome-devtools-mcp transport closed|Failed to launch the browser process|Could not find Chrome|Could not connect to Chrome|net::ERR_[A-Z_]+|\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND)\b/.test(text);
  const message = `MCP ${name} failed: ${text}`;
  return transport ? stepError("transport", message) : new Error(message);
}

export class ChromeDevToolsDriver implements Driver {
  private client?: Client;
  private transport?: StdioClientTransport;
  private initialUrl?: string;
  private snapshotCache?: string; // raw take_snapshot text, valid until the next action mutates the page
  private readonly seenPages = new Set<number>();
  private closed = false; // close() is terminal — a new session needs a new instance (#98)
  private crashed = false; // transport died mid-run — resuming on a fresh blank browser is worse than failing (#88)
  private lastRaw?: string; // raw snapshot the clickable probe last ran on — re-probe only on change (#132)
  private lastClickable?: Set<string>; // labels of roleless clickable regions, keyed by that raw
  private readonly driverId = ++nextDriverId;
  private observationVersion = 0;
  private observedRows: SnapshotRow[] = [];
  private observedPage?: string;
  private readonly references = new Map<string, SnapshotRow>();
  private readonly unguarded = new Set<string>();
  private readonly guardKey = `cairn-observation-guard:${this.driverId}`;
  private readonly regionKey = `cairn-clickable-regions:${this.driverId}`;

  constructor(private readonly opts: ChromeDriverOptions = {}) {}

  private async trackPages(): Promise<void> {
    try {
      parsePageIds(await this.call("list_pages")).forEach((id) => this.seenPages.add(id));
    } catch {
      /* best-effort */
    }
  }

  /** If the last action opened a new tab, switch to it — else later actions silently hit the wrong page. */
  private async followNewTab(): Promise<void> {
    try {
      const entries = parsePageEntries(await this.call("list_pages"));
      const followable = followableTab(entries, this.seenPages);
      entries.forEach((e) => this.seenPages.add(e.id));
      if (followable !== undefined) {
        this.invalidateObservation();
        await this.call("select_page", { pageId: followable });
        this.snapshotCache = undefined; // different tab → different DOM
      }
    } catch {
      /* best-effort */
    }
  }

  /** Reject after `ms` if `p` hasn't settled — so a hung MCP/subprocess never wedges the caller. */
  private async withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(stepError("transport", `${label} timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async ensureConnected(): Promise<Client> {
    if (this.closed) {
      throw stepError("transport", "driver closed — construct a new ChromeDevToolsDriver for a new session");
    }
    if (this.crashed) {
      throw stepError("transport", "browser session ended mid-run (chrome-devtools-mcp transport closed) — rerun with a new driver");
    }
    if (this.client) return this.client;
    const client = new Client({ name: "cairn-harness", version: "0.0.0" }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: this.opts.command ?? MCP_COMMAND,
      args: this.opts.args ?? MCP_ARGS,
    });
    // An unexpected transport close mid-run is fatal for this session: a silent reconnect would
    // resume the run on a fresh browser (about:blank, empty storage) and fail confusingly (#88).
    transport.onclose = () => {
      if (this.client === client) {
        this.client = undefined;
        this.transport = undefined;
        this.crashed = true;
      }
    };
    try {
      await this.withTimeout(
        client.connect(transport),
        this.opts.connectTimeoutMs ?? 60_000,
        "chrome-devtools-mcp connect",
      );
    } catch (err) {
      await transport.close().catch(() => {}); // don't orphan the spawned subprocess
      throw stepError("transport", `failed to start chrome-devtools-mcp: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.client = client;
    this.transport = transport;
    return client;
  }

  private async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const client = await this.ensureConnected();
    let res: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    try {
      res = (await this.withTimeout(
        client.callTool({ name, arguments: args }),
        this.opts.timeoutMs ?? 30_000,
        `MCP ${name}`,
      )) as typeof res;
    } catch (err) {
      // The SDK rejects raw, without an envelope, when the stdio transport dies under an in-flight
      // call (`MCP error -32000: Connection closed`, `Not connected`) — the very call that saw the
      // browser go. Type it here; the next call would hit `crashed` and be typed anyway.
      if (err instanceof Error && !errorKindOf(err) && /Connection closed|Not connected|MCP error -32000/.test(err.message)) {
        throw stepError("transport", `MCP ${name} failed: ${err.message}`);
      }
      throw err;
    }
    const text = (res.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    if (res.isError) throw mcpToolError(name, text);
    return text;
  }

  async goto(url: string): Promise<void> {
    this.invalidateObservation();
    if (this.initialUrl === undefined) this.initialUrl = url;
    // accept beforeunload so leaving a dirty form/page doesn't hang on a dialog.
    await this.call("navigate_page", { type: "url", url, handleBeforeUnload: "accept" });
    this.snapshotCache = undefined;
    await this.trackPages();
  }

  async click(target: Target, ref?: string): Promise<void> {
    const uid = await this.actionUid(target, ref);
    this.invalidateObservation();
    await this.callAccepting("click", { uid });
  }

  async doubleClick(target: Target, ref?: string): Promise<void> {
    const uid = await this.actionUid(target, ref);
    this.invalidateObservation();
    await this.callAccepting("click", { uid, dblClick: true });
  }

  /**
   * Run an interactive MCP action, accepting any JS dialog it triggers. A `confirm`/`alert`/`prompt`
   * opens a dialog the MCP can't interact through (no per-action hook) — the call errors and the run
   * would wedge. The action's own handler already fired, so accept the dialog and treat it as done
   * (#17). Generic over the action, so a dialog from a click, a form submit (Enter), a select, etc.
   * is handled the same way — no per-verb special-casing.
   */
  private async callAccepting(name: string, args: Record<string, unknown>): Promise<void> {
    try {
      await this.call(name, args);
    } catch (err) {
      if (!isOpenDialog(err)) throw err;
      await this.call("handle_dialog", { action: "accept" });
    }
    // Any interactive verb can open a tab (Enter submit, select onchange) — not just click (#89).
    await this.followNewTab();
  }

  async hover(target: Target, ref?: string): Promise<void> {
    const uid = await this.actionUid(target, ref);
    this.invalidateObservation();
    await this.call("hover", { uid });
  }

  async type(target: Target, text: string, ref?: string): Promise<void> {
    const uid = await this.actionUid(target, ref);
    this.invalidateObservation();
    await this.callAccepting("fill", { uid, value: text });
    // Let the app apply the input (controlled inputs, validation) before the next action — otherwise
    // a fast submit races an un-committed field. settle's idle floor gives that beat (readiness, #64).
    await this.settle();
  }

  async select(target: Target, value: string, ref?: string): Promise<void> {
    const uid = await this.actionUid(target, ref);
    // native <select>: chrome-devtools-mcp's `fill` sets .value — the special case (an OS chrome
    // whose option list can't be clicked), kept as a fast path.
    if (await this.isNativeSelect(uid)) {
      this.invalidateObservation();
      await this.callAccepting("fill", { uid, value });
      this.snapshotCache = undefined;
      await this.settle();
      return;
    }
    // Custom ARIA dropdown (a11y role `combobox`, but a real button + listbox popup): the general
    // case. Open it → wait for ITS options → click the one named `value`. `fill` would no-op here,
    // which used to make discover thrash. One `select` step still freezes as a single stable unit
    // (the control), so replay drives open→pick deterministically (no LLM).
    const before = new Set(parseSnapshotRows(await this.getSnapshot()).map((r) => r.uid));
    this.invalidateObservation();
    await this.callAccepting("click", { uid }); // activate/open
    this.snapshotCache = undefined;
    const optionUid = await this.awaitNewOption(value, before);
    if (!optionUid) {
      throw stepError("resolution", `select "${value}": no matching option appeared after opening the dropdown`);
    }
    await this.callAccepting("click", { uid: optionUid });
    this.snapshotCache = undefined;
    await this.settle();
  }

  /** The `value`'s `option` row among rows that appeared AFTER the dropdown opened — the watermark
   * (`before`) keeps a native <select>'s always-present options elsewhere from being mismatched.
   * Exact name wins; else a single substring; several exact matches is ambiguous → nothing (#127).
   * Deterministic string matching, no LLM (invariant #4). */
  private async awaitNewOption(value: string, before: ReadonlySet<string>): Promise<string | undefined> {
    const needle = value.trim().toLowerCase();
    const deadline = Date.now() + OPTION_WAIT_MS;
    for (;;) {
      this.snapshotCache = undefined;
      const fresh = parseSnapshotRows(await this.getSnapshot()).filter(
        (r) => !before.has(r.uid) && r.role === "option",
      );
      const exact = fresh.filter((r) => r.name.trim().toLowerCase() === needle);
      if (exact.length === 1) return exact[0]!.uid;
      if (exact.length === 0) {
        const subs = fresh.filter((r) => r.name.trim().toLowerCase().includes(needle));
        if (subs.length === 1) return subs[0]!.uid;
      }
      if (Date.now() >= deadline) return undefined;
      await delay(OPTION_POLL_MS);
    }
  }

  /** Whether the resolved element is a real native `<select>` (vs a custom ARIA combobox that shares
   * the a11y role but no-ops on `fill`). Decided by the element's tag, not its a11y role — both render
   * as `combobox` — via an in-page probe. Best-effort: an unreachable probe treats it as non-native. */
  private async isNativeSelect(uid: string): Promise<boolean> {
    try {
      const reply = await this.call("evaluate_script", {
        function: "(el) => ({ tag: el ? el.tagName : null })",
        args: [uid],
      });
      return (extractFirstJsonObject(reply) as { tag?: unknown } | undefined)?.tag === "SELECT";
    } catch {
      return false;
    }
  }

  async pressKey(key: string): Promise<void> {
    this.invalidateObservation();
    // a form submit (Enter) can trigger a confirm() — handle it like any other action.
    await this.callAccepting("press_key", { key });
    this.snapshotCache = undefined;
  }

  async scroll(direction: "down" | "up" = "down"): Promise<void> {
    this.invalidateObservation();
    const sign = direction === "up" ? "-" : "";
    await this.call("evaluate_script", {
      function: `() => { window.scrollBy(0, ${sign}window.innerHeight * 0.9); }`,
    });
    this.snapshotCache = undefined;
  }

  async screenshot(): Promise<string | undefined> {
    try {
      const client = await this.ensureConnected();
      const res = (await this.withTimeout(
        client.callTool({ name: "take_screenshot", arguments: { format: "png" } }),
        this.opts.timeoutMs ?? 30_000,
        "MCP take_screenshot",
      )) as { content?: Array<{ type: string; data?: string; mimeType?: string }> };
      const img = (res.content ?? []).find((c) => c.type === "image" && typeof c.data === "string");
      return img?.data ? `data:${img.mimeType ?? "image/png"};base64,${img.data}` : undefined;
    } catch {
      return undefined; // screenshots are best-effort; never fail a run
    }
  }

  /** Cache the page snapshot so resolve + the discover loop don't both re-fetch it; actions invalidate it. */
  private async getSnapshot(): Promise<string> {
    if (this.snapshotCache === undefined) this.snapshotCache = await this.call("take_snapshot");
    return this.snapshotCache;
  }

  async snapshot(options?: SnapshotOptions): Promise<PageElement[]> {
    // Always observe fresh — a waitFor poll runs no actions, so a kept cache would never see
    // self-rendered content (#85). The cache still serves locate() within the same turn.
    this.invalidateObservation();
    let guarded = false;
    if (options?.perception) {
      // Install before capture so changed sibling order cannot freeze an already-stale ordinal.
      try {
        await this.call("evaluate_script", { function: this.startObservationGuard() });
        guarded = true;
      } catch (err) {
        if (errorKindOf(err) === "transport") throw err;
        // A browser that cannot install the guard can still supply ordinary candidates.
      }
    }
    // Perception has a larger candidate pool than ordinary lookup and select's watermark.
    // Keep its full tree local so those compact-snapshot consumers retain their ordinals.
    const raw = options?.perception
      ? await this.call("take_snapshot", { verbose: true })
      : await this.getSnapshot();
    const els = parseElements(raw);
    if (options?.perception) {
      const version = ++this.observationVersion;
      const page = await this.selectedPage();
      this.observedPage = page;
      // MCP's verbose tree includes virtual InlineTextBox entries with shared/unresolvable UIDs.
      // The owning StaticText remains available; virtual glyph runs cannot be action targets.
      this.observedRows = parseSnapshotRows(raw).filter(row => row.role !== "InlineTextBox");
      const named = this.observedRows.filter((row) => row.name.trim());
      const facts = await this.probePerceptionFacts(named);
      return els.filter(element => element.role !== "InlineTextBox").map((element, i) => {
        const row = named[i]!;
        const ref = `cairn:${this.driverId}:${version}:${row.uid}`;
        // A failed page measurement preserves candidates but cannot promise exact identity.
        // All candidates share the frozen ordinal pool. An unguarded shadow/frame row can
        // change the ordinal of a document row too, so coverage must hold for the whole capture.
        const addressable = guarded && page !== undefined && this.unguarded.size === 0;
        if (addressable) this.references.set(ref, row);
        return { ...element, ...facts.get(row.uid), ...(addressable ? { ref } : {}) };
      });
    }
    if (this.opts.promoteClickables === false) return els;
    // Overlay clickable-region promotion (#132) — re-probe only when the raw tree changed, so a
    // waitFor poll on a static page adds no cost. The label's a11y role stays StaticText for
    // resolution (a click on it bubbles to the region); only the listing shows it as clickable.
    if (raw !== this.lastRaw) {
      this.lastRaw = raw;
      this.lastClickable = await this.probeClickableLabels(raw);
    }
    const clickable = this.lastClickable;
    if (clickable && clickable.size) {
      for (const el of els) {
        if (el.role === "StaticText" && clickable.has(el.name.trim())) el.role = "button";
      }
    }
    return els;
  }

  private async probePerceptionFacts(rows: SnapshotRow[]): Promise<Map<string, Partial<PageElement>>> {
    const facts = new Map<string, Partial<PageElement>>();
    if (!rows.length) return facts;
    const measure = async (batch: SnapshotRow[]): Promise<void> => {
      const uids = batch.map((row) => row.uid);
      let reply: string;
      try {
        reply = await this.call("evaluate_script", {
          function: perceptionProbeScript(uids, this.opts.promoteClickables !== false, this.regionKey, this.guardKey),
          args: uids,
        });
      } catch (err) {
        if (errorKindOf(err) === "transport") throw err;
        // MCP refuses mixed-frame batches and detached UIDs. Split by original rows; one
        // unsupported node must not erase measurable main-page facts. Region IDs use the
        // first candidate UID in a page-local WeakMap, so they survive batch boundaries.
        if (batch.length > 1) {
          const middle = Math.ceil(batch.length / 2);
          await measure(batch.slice(0, middle));
          await measure(batch.slice(middle));
        } else {
          this.unguarded.add(batch[0]!.uid);
        }
        return;
      }
      const reported = extractFirstJsonObject(reply) as Record<string, unknown> | undefined;
      for (const uid of uids) {
        const value = reported?.[uid];
        if (!value || typeof value !== "object") { this.unguarded.add(uid); continue; }
        const raw = value as Record<string, unknown>;
        if (raw.referenceReady !== true) this.unguarded.add(uid);
        const row: Partial<PageElement> = {};
        if (typeof raw.inActivePopup === "boolean") row.inActivePopup = raw.inActivePopup;
        if (typeof raw.occluded === "boolean") row.occluded = raw.occluded;
        if (this.opts.promoteClickables !== false) {
          if (typeof raw.clickable === "boolean") row.clickable = raw.clickable;
          if (typeof raw.clickableRegion === "string") row.clickableRegion = raw.clickableRegion;
        }
        facts.set(uid, row);
      }
    };
    await measure(rows);
    return facts;
  }

  private startObservationGuard(): string {
    return `() => {
      const key = Symbol.for(${JSON.stringify(this.guardKey)});
      globalThis[key]?.observer.disconnect();
      const state = { changed: false, observer: new MutationObserver(() => { state.changed = true; }) };
      state.observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
      globalThis[key] = state;
      globalThis[Symbol.for(${JSON.stringify(this.regionKey)})] = new WeakMap();
      return {};
    }`;
  }

  /** Labels of roleless `cursor:pointer` regions (#132), one per region (de-nested), capped.
   * Candidates = named StaticText rows (a region's visible label); the DOM probe reports each one's
   * clickable-region id. Best-effort — a failed probe promotes nothing. Uses only web-universal
   * signals (invariant #1). */
  private async probeClickableLabels(raw: string): Promise<Set<string>> {
    const candidates = parseSnapshotRows(raw).filter((r) => r.role === "StaticText" && r.name.trim());
    if (!candidates.length) return new Set();
    try {
      const reply = await this.call("evaluate_script", {
        function: CLICKABLE_PROBE,
        args: candidates.map((r) => r.uid),
      });
      const regions = extractFirstJsonArray(reply);
      if (!Array.isArray(regions)) return new Set();
      return promotedClickableNames(candidates, regions);
    } catch {
      return new Set();
    }
  }

  async settle(options: SettleOptions = {}): Promise<void> {
    // Chrome defers low-priority resources (favicon, web fonts) past the usual 500ms
    // "network-idle" window, so the idle threshold is generous — missing a late request
    // would mean missing a real failure. Tune via SettleOptions.
    const idleMs = options.idleMs ?? 1_000;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const pollMs = options.pollMs ?? 250;
    // Tolerate a trickle of background traffic (analytics beacons, polling, websockets) so
    // those sites reach "idle" instead of always burning the full timeout; a real load
    // burst (>1 new request in the window) still resets the wait.
    const tolerance = 1;
    const deadline = Date.now() + timeoutMs;
    let windowStart = Date.now();
    let windowBase = -1;
    try {
      while (Date.now() < deadline) {
        const count = parseNetwork(await this.call("list_network_requests")).length;
        if (windowBase < 0 || count - windowBase > tolerance) {
          windowBase = count;
          windowStart = Date.now();
        } else if (Date.now() - windowStart >= idleMs) {
          return; // at most a trickle over idleMs — treat as network-idle
        }
        await delay(pollMs);
      }
    } catch {
      // best-effort: settling must never fail a run (port contract).
    }
  }

  async observe(): Promise<Evidence> {
    const [pages, network, console] = await Promise.all([
      this.call("list_pages"),
      this.call("list_network_requests"),
      this.call("list_console_messages"),
    ]);

    const finalUrl = parseSelectedUrl(pages);
    const navigated = finalUrl !== undefined && isNavigation(this.initialUrl, finalUrl);

    return {
      execution: { actions: [], navigated, finalUrl, blocked: false },
      perception: {},
      logic: { requests: parseNetwork(network), console: parseConsole(console) },
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined; // clear first so onclose treats this as an intentional close
    this.transport = undefined;
    this.closed = true;
    this.seenPages.clear();
    this.invalidateObservation();
    this.initialUrl = undefined;
    this.lastRaw = undefined;
    this.lastClickable = undefined;
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {}); // also kill the subprocess on partial/abnormal state
  }

  async locate(target: Target): Promise<Target> {
    const rows = parseSnapshotRows(await this.getSnapshot());
    const uid = await this.resolveVisible(rows, target);
    if (!uid) return target; // can't enrich right now — freeze what we have
    const row = rows.find((r) => r.uid === uid)!;
    const index = rows.filter((r) => r.role === row.role).findIndex((r) => r.uid === uid);
    // Duplicate accessible names (a list UI: "Accept" ×N) make first-match resolution ambiguous —
    // record the 0-based position among the same-named so the frozen target says WHICH one (#92).
    // Computed over exactly the pool replay's name stage will use (same role, same frozen name),
    // and skipped when the frozen text was only a substring match (the pools would differ).
    const frozenText = (target.text ?? row.name).trim().toLowerCase();
    const dupes = rows.filter((r) => r.role === row.role && r.name.toLowerCase() === frozenText);
    const nth = dupes.length > 1 ? dupes.findIndex((r) => r.uid === uid) : -1;
    return { ...target, text: target.text ?? row.name, role: row.role, index, ...(nth >= 0 ? { nth } : {}) };
  }

  async locateRef(ref: string): Promise<Target> {
    const row = await this.referenceRow(ref);
    const index = this.observedRows.filter((candidate) => candidate.role === row.role).findIndex((candidate) => candidate.uid === row.uid);
    const dupes = this.observedRows.filter((candidate) => candidate.role === row.role && candidate.name.trim().toLowerCase() === row.name.trim().toLowerCase());
    const nth = dupes.length > 1 ? dupes.findIndex((candidate) => candidate.uid === row.uid) : undefined;
    return { text: row.name, role: row.role, index, ...(nth !== undefined ? { nth } : {}) };
  }

  private async referenceRow(ref: string): Promise<SnapshotRow> {
    const row = this.references.get(ref);
    if (!row) throw stepError("resolution", "unknown or expired observation ref — take a fresh snapshot");
    const page = await this.selectedPage();
    if (page === undefined || page !== this.observedPage) {
      this.invalidateObservation();
      throw stepError("resolution", "observation ref expired: active page continuity is unavailable");
    }
    try {
      // MCP resolves the captured UID to its original backend node. A detached/replaced node
      // cannot be re-found by name here, even when the replacement has identical page text.
      const reply = await this.call("evaluate_script", {
        function: `(el) => {
          const state = globalThis[Symbol.for(${JSON.stringify(this.guardKey)})];
          const unchanged = !!state && !state.changed && state.observer.takeRecords().length === 0;
          return { connected: unchanged && !!el && el.isConnected && el.getRootNode() === document };
        }`,
        args: [row.uid],
      });
      if ((extractFirstJsonObject(reply) as { connected?: unknown } | undefined)?.connected !== true) {
        throw new Error("observed node is detached or its continuity is unavailable");
      }
    } catch (err) {
      this.invalidateObservation();
      if (errorKindOf(err) === "transport") throw err;
      throw stepError("resolution", `observation ref expired: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.references.get(ref) !== row) {
      throw stepError("resolution", "observation ref expired while validating the node");
    }
    return row;
  }

  private async actionUid(target: Target, ref?: string): Promise<string> {
    return ref === undefined ? this.resolveUid(target) : (await this.referenceRow(ref)).uid;
  }

  private async selectedPage(): Promise<string | undefined> {
    try {
      // Include the URL as well as the tab ID: navigation can retain the selected tab.
      return (await this.call("list_pages")).match(/^\s*(\d+:[^\n]*\[selected\])\s*$/m)?.[1];
    } catch {
      return undefined;
    }
  }

  private invalidateObservation(): void {
    this.references.clear();
    this.unguarded.clear();
    this.observedRows = [];
    this.observedPage = undefined;
    this.snapshotCache = undefined;
  }

  private async resolveUid(target: Target): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const rows = parseSnapshotRows(await this.getSnapshot());
      const uid =
        (target.selector ? await this.resolveSelectorUid(rows, target.selector) : undefined) ??
        (await this.resolveVisible(rows, target));
      if (uid) return uid;
      if (attempt >= RESOLVE_RETRIES) {
        throw stepError("resolution", describeResolutionMiss(rows, target));
      }
      this.snapshotCache = undefined; // re-fetch — the element may render on a later frame
      await delay(RESOLVE_RETRY_MS);
      // A target discovered in the full tree (notably a portal option) may be omitted by MCP's
      // compact snapshot even when present. Retry with full capture before declaring it absent.
      this.snapshotCache = await this.call("take_snapshot", { verbose: true });
    }
  }

  /**
   * `resolveTargetUid`, plus a hit test when the name is ambiguous ACROSS roles (#176). That case
   * resolves by tree order today — deliberately, because an a11y wrapper pair (link "X" over
   * StaticText "X") is two rows for one element — but the same shape covers a real failure: a
   * modal's button and a background nav link share a name, and tree order picks the background
   * link, navigating away instead of submitting. `role=dialog` is absent on plenty of real modals,
   * so the reachable candidate is the signal: a backdrop-covered or hidden element fails a
   * center-point hit test, the wrapper pair still answers with its own element's role.
   *
   * The probe reports a ROLE, not an element: the MCP text interface has no uid → DOM mapping, so
   * the answer is fed back through the existing role narrowing instead of joined positionally.
   * Nothing reachable, an unmapped role, or a page that refuses the script leaves the current
   * tree-order behavior untouched (fail-safe), and replay stays model-free either way (invariant #4).
   */
  private async resolveVisible(rows: SnapshotRow[], target: Target): Promise<string | undefined> {
    const candidates = crossRoleCandidates(rows, target);
    if (!candidates.length) return resolveTargetUid(rows, target); // no probe when nothing is ambiguous
    const role = probedRole(candidates, await this.probeReachableRoles(target.text!));
    return resolveTargetUid(rows, role ? { ...target, role } : target);
  }

  /** Roles of the same-named elements a center-point hit test actually reaches; [] on any failure. */
  private async probeReachableRoles(
    text: string,
  ): Promise<{ reachable: string[]; occluded: string[]; unknown: string[] }> {
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((r): r is string => typeof r === "string") : [];
    try {
      const reply = await this.call("evaluate_script", { function: reachableRolesProbeScript(text) });
      const probe = extractFirstJsonObject(reply) as
        | { reachable?: unknown; occluded?: unknown; unknown?: unknown }
        | undefined;
      return {
        reachable: strings(probe?.reachable),
        occluded: strings(probe?.occluded),
        unknown: strings(probe?.unknown),
      };
    } catch {
      return { reachable: [], occluded: [], unknown: [] };
    }
  }

  /** Resolve a CSS selector to a snapshot uid: read the element's accessible name in-page, then
   * join it back to the a11y snapshot (the MCP text interface has no direct CSS→uid mapping). */
  private async resolveSelectorUid(rows: SnapshotRow[], selector: string): Promise<string | undefined> {
    try {
      const reply = await this.call("evaluate_script", { function: selectorProbeScript(selector) });
      const probe = extractFirstJsonObject(reply) as { name?: unknown } | undefined;
      const name = typeof probe?.name === "string" ? probe.name.trim() : "";
      return name ? resolveTargetUid(rows, { text: name }) : undefined;
    } catch {
      return undefined; // fall through to text/role locators, then self-heal
    }
  }
}

// --- parsers for chrome-devtools-mcp's text output -------------------------------

/** True if MCP's error text says a JS dialog (confirm/alert/prompt) is open and blocking. */
export function isDialogBlocked(text: string): boolean {
  return /open dialog/i.test(text) || /handle_dialog/i.test(text);
}

/** True if an MCP error means a click opened a JS dialog (confirm/alert/prompt) that now blocks. */
export function isOpenDialog(err: unknown): boolean {
  return isDialogBlocked(err instanceof Error ? err.message : String(err));
}

/** `uid=1_3 link "Learn more" …` → {role:"link", name:"Learn more"} for named rows, with form
 * state (#93) parsed from the attribute tail: booleans render bare (`checked`, `disabled` — not
 * the `checkable`/`disableable` capability tokens), strings as `attr="…"`. */
export function parseElements(snapshot: string): PageElement[] {
  const out: PageElement[] = [];
  for (const line of snapshot.split("\n")) {
    const m = line.match(/uid=\S+\s+(\w+)\s+"([^"]*)"/);
    if (!m || !m[2]!.trim()) continue;
    const el: PageElement = { role: m[1]!, name: m[2]! };
    // Only the tail after the quoted name — a name like "I have checked the box" must not match.
    const tail = line.slice(m.index! + m[0].length);
    if (/(?:^|\s)checked="mixed"/.test(tail)) el.checked = "mixed";
    else if (/(?:^|\s)checked(?:\s|$)/.test(tail)) el.checked = true;
    if (/(?:^|\s)disabled(?:\s|$)/.test(tail)) el.disabled = true;
    const value = tail.match(/(?:^|\s)value="([^"]*)"/);
    if (value) el.value = value[1]!;
    out.push(el);
  }
  return out;
}

export interface SnapshotRow {
  uid: string;
  role: string;
  name: string;
}

/** `uid=1_3 link "Learn more" …` → ordered {uid, role, name} rows (the role-adjacent quoted name). */
export function parseSnapshotRows(snapshot: string): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  for (const line of snapshot.split("\n")) {
    const m = line.match(/uid=(\S+)\s+(\w+)\s+"([^"]*)"/);
    if (m) rows.push({ uid: m[1]!, role: m[2]!, name: m[3]! });
  }
  return rows;
}

/**
 * Multi-locator resolution. Prefers the accessible name (exact over substring, role-aware if
 * known); `nth` addresses the Nth name match when several elements carry the same name (#92).
 * If the name no longer matches, falls back to role + structural index so a renamed control still
 * resolves WITHOUT the LLM — but only when that fallback is unambiguous (P3): with several same-role
 * candidates a reorder would silently select the wrong element, so it yields nothing and lets
 * self-heal pick by intent instead.
 */
export function resolveTargetUid(rows: SnapshotRow[], target: Target): string | undefined {
  const roleOk = (r: SnapshotRow) => !target.role || r.role === target.role;
  if (target.text) {
    const needle = target.text.trim().toLowerCase();
    const exacts = rows.filter((r) => roleOk(r) && r.name.toLowerCase() === needle);
    const subs = rows.filter((r) => roleOk(r) && r.name.trim() !== "" && r.name.toLowerCase().includes(needle));
    if (target.nth !== undefined) {
      // An explicit position among the name matches — the designed address for identically-named
      // elements. Out of range (the list shrank/renamed) yields nothing: never guess a neighbor.
      const pool = exacts.length ? exacts : subs;
      return pool[target.nth]?.uid;
    }
    // Several exact matches within ONE role is a guess like any other (#127) — the class the
    // (nth=K) prompt markers name. Yield nothing: discovery re-decides with role/nth, replay
    // falls to self-heal. Cross-role multi-matches keep tree-order-first: an a11y tree routinely
    // shows a wrapper pair (link "X" over StaticText "X") where either uid acts on the same thing,
    // and the model can already disambiguate real cross-role duplicates by sending "role".
    if (exacts.length === 1) return exacts[0]!.uid;
    if (exacts.length > 1) {
      return hasSameRoleDupes(exacts) ? undefined : exacts[0]!.uid;
    }
    // Substring fallback only when it's unambiguous — several partial matches is a guess (like the
    // positional guard below), so yield nothing and let self-heal pick by intent instead of mis-clicking.
    if (subs.length === 1) return subs[0]!.uid;
  }
  if (target.role && target.index !== undefined) {
    const sameRole = rows.filter((r) => r.role === target.role);
    // A positional fallback after a name miss is a guess — trust it only when unambiguous.
    if (target.text && sameRole.length > 1) return undefined;
    return sameRole[target.index]?.uid;
  }
  return undefined;
}

/**
 * The distinct roles of the exact name matches that `resolveTargetUid` would settle by TREE ORDER —
 * the cross-role ambiguity it deliberately does not refuse (#127). Empty when the target already
 * says which element it means (`role`/`nth`), when the name resolves without a guess, or when the
 * matches repeat a role (that class is refused, not guessed).
 */
export function crossRoleCandidates(rows: SnapshotRow[], target: Target): string[] {
  if (!target.text || target.role || target.nth !== undefined) return [];
  const needle = target.text.trim().toLowerCase();
  const exacts = rows.filter((r) => r.name.toLowerCase() === needle);
  if (exacts.length < 2 || hasSameRoleDupes(exacts)) return [];
  return [...new Set(exacts.map((r) => r.role))];
}

/**
 * The one role to narrow a cross-role ambiguity by — and only on evidence. Narrowing requires that
 * every candidate role was accounted for by the probe, that none of them is merely unmeasured, and
 * that exactly one is reachable. Anything else abstains and the caller keeps the existing
 * tree-order behavior, which is what this did before #176.
 */
export function probedRole(
  candidates: readonly string[],
  probe: { reachable: readonly string[]; occluded?: readonly string[]; unknown?: readonly string[] },
): string | undefined {
  const { reachable, occluded = [], unknown = [] } = probe;
  // Every candidate must be accounted for. A role the probe placed in no bucket is one it never
  // saw — inside a shadow root or an iframe, named by `aria-labelledby`, or mapped to a role this
  // script spells differently — and "the one I could see" is then a guess, wrong in exactly the
  // case this exists to fix: the real target hidden from the probe, a visible decoy beside it.
  const seen = new Set([...reachable, ...occluded, ...unknown]);
  if (!candidates.every((r) => seen.has(r))) return undefined;
  if (unknown.some((r) => candidates.includes(r))) return undefined;
  const hits = [...new Set(reachable)].filter((r) => candidates.includes(r));
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * In-page probe over the elements named `text`, sorted by what a center-point hit test can say:
 * `reachable` (the point lands on it), `occluded` (it lands on something else — a backdrop), and
 * `unknown` (below the fold, zero-size, nothing at the point, or scrolled out of its own
 * `overflow` container). The split matters because the driver clicks through puppeteer's `Locator`,
 * which scrolls the target into view first — the window and any clipping ancestor alike — and the
 * a11y snapshot it narrows is unfiltered by viewport. So a control the viewer cannot see right now
 * is still a perfectly good click target, and treating it as unreachable would narrow onto a
 * visible decoy instead. Only being covered where it does sit is evidence. `value` is read for inputs, since `<input type="submit" value="Continue">`
 * is the common modal submit and carries its name nowhere else.
 *
 * All three buckets are returned, including the one the caller then ignores: `occluded` is how the
 * caller tells "the page hid it" from "this probe never saw it". The probe's reach is narrower than
 * the a11y tree in four known ways — it does not enter shadow roots or iframes, its name is a
 * short approximation (no `aria-labelledby`, no `<label for>`, no `alt`), and its role mapping is
 * coarser (`input[type=number]` is `spinbutton` in the tree, `textbox` here). A candidate the probe
 * cannot account for at all lands in none of the buckets, and `probedRole` refuses to narrow on
 * that — which is cheaper and safer than teaching this script to compute accessible names.
 */
export function reachableRolesProbeScript(text: string): string {
  return (
    `() => { const want = ${JSON.stringify(text.trim().toLowerCase())}; ` +
    `const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase(); ` +
    `const named = (el) => norm(el.getAttribute("aria-label") || el.getAttribute("title") || ` +
    `(el.tagName.toLowerCase() === "input" ? el.getAttribute("value") : null) || el.textContent); ` +
    `const roleOf = (el) => { const explicit = el.getAttribute("role"); if (explicit) return explicit.trim(); ` +
    `const tag = el.tagName.toLowerCase(); const type = (el.getAttribute("type") || "").toLowerCase(); ` +
    `if (tag === "a") return el.hasAttribute("href") ? "link" : "generic"; ` +
    `if (tag === "button" || tag === "summary") return "button"; ` +
    `if (tag === "input") { if (type === "checkbox" || type === "radio") return type; ` +
    `return ["submit", "button", "reset", "image"].includes(type) ? "button" : "textbox"; } ` +
    `if (tag === "textarea") return "textbox"; if (tag === "select") return "combobox"; return "generic"; }; ` +
    // "reachable" / "occluded" / "unknown" — the driver clicks through puppeteer's Locator, which
    // scrolls first, so a control below the fold is not unreachable, it is unmeasured. Only a hit
    // test that lands on something ELSE is evidence of occlusion.
    // A candidate whose centre falls outside one of its own scroll containers is clipped, not
    // covered: puppeteer scrolls that container and clicks it. The walk stops before <body>, or a
    // page that scrolls at the root would turn every real occlusion — a modal backdrop lives in the
    // body too — into an abstention.
    `const clippedByOwnBox = (el, x, y) => { ` +
    `if (getComputedStyle(el).position === "fixed") return false; ` +
    `for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) { ` +
    `const st = getComputedStyle(p); ` +
    `if (st.position === "fixed") return false; ` +
    `if (!/(auto|scroll|overlay|hidden)/.test(st.overflowY + " " + st.overflowX)) continue; ` +
    `const b = p.getBoundingClientRect(); ` +
    `if (x < b.left || x > b.right || y < b.top || y > b.bottom) return true; } return false; }; ` +
    `const classify = (el) => { const r = el.getBoundingClientRect(); ` +
    `if (!r.width || !r.height) return "unknown"; ` +
    `const x = r.left + r.width / 2, y = r.top + r.height / 2; ` +
    `if (clippedByOwnBox(el, x, y)) return "unknown"; ` +
    `if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return "unknown"; ` +
    `const top = document.elementFromPoint(x, y); if (!top) return "unknown"; ` +
    `return top === el || el.contains(top) ? "reachable" : "occluded"; }; ` +
    `const buckets = { reachable: [], occluded: [], unknown: [] }; ` +
    `for (const el of document.querySelectorAll("a,button,summary,input,textarea,select,[role]")) { ` +
    `if (named(el) !== want) continue; const bucket = buckets[classify(el)]; const role = roleOf(el); ` +
    `if (!bucket.includes(role)) bucket.push(role); } ` +
    `return buckets; }`
  );
}

/** True when two or more rows share one role — the ambiguity class the resolver refuses (#127). */
function hasSameRoleDupes(rows: SnapshotRow[]): boolean {
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.role)) return true;
    seen.add(r.role);
  }
  return false;
}

/** Why a target failed to resolve — ambiguity is named (with the fix) so a discover failure tells
 * the model HOW to re-decide instead of reading as "element doesn't exist" (#127). */
export function describeResolutionMiss(rows: SnapshotRow[], target: Target): string {
  if (target.text && target.nth === undefined) {
    const needle = target.text.trim().toLowerCase();
    const exacts = rows.filter(
      (r) => (!target.role || r.role === target.role) && r.name.toLowerCase() === needle,
    );
    if (exacts.length > 1 && hasSameRoleDupes(exacts)) {
      const roles = [...new Set(exacts.map((r) => r.role))].join("/");
      return `${exacts.length} elements named "${target.text}" (${roles}) — add "role" (and 0-based "nth" if that role still repeats)`;
    }
  }
  return `no element matching ${JSON.stringify(target)}`;
}

/** Resolve a uid by accessible name only (exact over substring) — used by the discover snapshot path. */
export function findUidByName(snapshot: string, text: string): string | undefined {
  return resolveTargetUid(parseSnapshotRows(snapshot), { text });
}

/** `reqid=5 GET https://… [200]` → NetworkRequest[]; a non-numeric status (`[pending]` = in-flight) → 0. */
export function parseNetwork(text: string): NetworkRequest[] {
  const out: NetworkRequest[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^reqid=\d+\s+(\w+)\s+(\S+)\s+\[([^\]]+)\]/);
    if (m) {
      const status = /^\d+$/.test(m[3]!) ? Number(m[3]) : 0;
      out.push({ method: m[1]!, url: m[2]!, status });
    }
  }
  return out;
}

/** `msgid=1 [error] message (1 args)` → {type:"error", text:"message"}. */
export function parseConsole(text: string): ConsoleMessage[] {
  const out: ConsoleMessage[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^msgid=\d+\s+\[(\w+)\]\s+(.*)$/);
    if (m) out.push({ type: m[1]!.toLowerCase(), text: m[2]!.replace(/\s*\(\d+ args?\)\s*$/, "").trim() });
  }
  return out;
}

/** Canonicalize a url for comparison: drop a trailing slash and the hash. */
export function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.origin}${url.pathname.replace(/\/$/, "")}${url.search}`;
  } catch {
    return u.replace(/[/#]+$/, "");
  }
}

/** True only if the page genuinely moved — not just a trailing-slash difference. */
export function isNavigation(initialUrl: string | undefined, finalUrl: string): boolean {
  if (initialUrl === undefined) return true;
  return normalizeUrl(initialUrl) !== normalizeUrl(finalUrl);
}

/** In-page probe returning the selector-matched element's accessible name as JSON (or null). */
export function selectorProbeScript(selector: string): string {
  return (
    `() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
    `return el ? { name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim() } : null; }`
  );
}

/** `4: Example Domain (…) [selected]` → page ids [4]. Ids are stable, increasing numbers. */
export function parsePageIds(text: string): number[] {
  return parsePageEntries(text).map((e) => e.id);
}

export interface PageEntry {
  id: number;
  url?: string;
}

/** `2: Example Domain (https://example.com/) [selected]` / `1: about:blank` → {id, url}. */
export function parsePageEntries(text: string): PageEntry[] {
  const out: PageEntry[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+):\s*(.*)$/);
    if (!m) continue;
    const rest = m[2]!;
    const paren = rest.match(/\((https?:\/\/[^)]+)\)/);
    const bare = rest.match(/^(\S+:\S*)/);
    out.push({ id: Number(m[1]), url: paren?.[1] ?? bare?.[1] });
  }
  return out;
}

/** The newest unseen tab that is a real page — a fresh `about:blank`/url-less tab is not a
 * destination to follow (#89), it's a popup shell or a page still initialising. */
export function followableTab(entries: PageEntry[], seen: ReadonlySet<number>): number | undefined {
  const real = entries.filter((e) => !seen.has(e.id) && e.url && e.url !== "about:blank");
  return real.length ? Math.max(...real.map((e) => e.id)) : undefined;
}

/** `2: Example Domain (https://example.com/) [selected]` → the selected page's url. */
export function parseSelectedUrl(text: string): string | undefined {
  for (const line of text.split("\n")) {
    if (!line.includes("[selected]")) continue;
    const paren = line.match(/\((https?:\/\/[^)]+)\)/);
    if (paren) return paren[1];
    const bare = line.match(/:\s*(\S+)\s*\[selected\]/);
    if (bare) return bare[1];
  }
  return undefined;
}
