/**
 * Default Driver — drives a real browser via the Chrome DevTools MCP server, which this
 * embeds as a client and spawns over stdio (so `cairn run` is self-contained). Everything
 * Chrome-specific, including parsing the MCP's human-readable text, stays here behind the
 * Driver port (invariant #5).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { extractFirstJsonArray, extractFirstJsonObject } from "../../core/json.js";
import type { Driver } from "../../core/ports.js";
import type {
  ConsoleMessage,
  Evidence,
  NetworkRequest,
  PageElement,
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

// A roleless clickable region (a card that's a div + cursor:pointer, not a native/ARIA control) is
// invisible to a11y-based perception: the model can't target it and gets drawn to a name-matching
// nav link instead. Promote the label of such a region to a clickable — universally, no framework
// assumptions: cursor:pointer AND an inline/property click handler on a roleless, non-native ancestor.
// Requiring the handler both removes false positives (a pointer-styled decoration) and de-nests for
// free (the handler sits on the region root, not the inner text). Handlers attached another way —
// React delegates onClick at the root, invisible to the DOM — are app/framework knowledge, so a
// consumer driver's job (invariant #1), not this reference driver's. Capped so a busy page can't flood.
const MAX_PROMOTED_CLICKABLES = 40;
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
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async ensureConnected(): Promise<Client> {
    if (this.closed) {
      throw new Error("driver closed — construct a new ChromeDevToolsDriver for a new session");
    }
    if (this.crashed) {
      throw new Error("browser session ended mid-run (chrome-devtools-mcp transport closed) — rerun with a new driver");
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
      throw new Error(`failed to start chrome-devtools-mcp: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.client = client;
    this.transport = transport;
    return client;
  }

  private async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const client = await this.ensureConnected();
    const res = (await this.withTimeout(
      client.callTool({ name, arguments: args }),
      this.opts.timeoutMs ?? 30_000,
      `MCP ${name}`,
    )) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = (res.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    if (res.isError) throw new Error(`MCP ${name} failed: ${text}`);
    return text;
  }

  async goto(url: string): Promise<void> {
    if (this.initialUrl === undefined) this.initialUrl = url;
    // accept beforeunload so leaving a dirty form/page doesn't hang on a dialog.
    await this.call("navigate_page", { type: "url", url, handleBeforeUnload: "accept" });
    this.snapshotCache = undefined;
    await this.trackPages();
  }

  async click(target: Target): Promise<void> {
    await this.callAccepting("click", { uid: await this.resolveUid(target) });
    this.snapshotCache = undefined;
  }

  async doubleClick(target: Target): Promise<void> {
    await this.callAccepting("click", { uid: await this.resolveUid(target), dblClick: true });
    this.snapshotCache = undefined;
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

  async hover(target: Target): Promise<void> {
    await this.call("hover", { uid: await this.resolveUid(target) });
    this.snapshotCache = undefined;
  }

  async type(target: Target, text: string): Promise<void> {
    await this.callAccepting("fill", { uid: await this.resolveUid(target), value: text });
    this.snapshotCache = undefined;
    // Let the app apply the input (controlled inputs, validation) before the next action — otherwise
    // a fast submit races an un-committed field. settle's idle floor gives that beat (readiness, #64).
    await this.settle();
  }

  async select(target: Target, value: string): Promise<void> {
    const uid = await this.resolveUid(target);
    // native <select>: chrome-devtools-mcp's `fill` sets .value — the special case (an OS chrome
    // whose option list can't be clicked), kept as a fast path.
    if (await this.isNativeSelect(uid)) {
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
    await this.callAccepting("click", { uid }); // activate/open
    this.snapshotCache = undefined;
    const optionUid = await this.awaitNewOption(value, before);
    if (!optionUid) {
      throw new Error(`select "${value}": no matching option appeared after opening the dropdown`);
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
    // a form submit (Enter) can trigger a confirm() — handle it like any other action.
    await this.callAccepting("press_key", { key });
    this.snapshotCache = undefined;
  }

  async scroll(direction: "down" | "up" = "down"): Promise<void> {
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

  async snapshot(): Promise<PageElement[]> {
    // Always observe fresh — a waitFor poll runs no actions, so a kept cache would never see
    // self-rendered content (#85). The cache still serves locate() within the same turn.
    this.snapshotCache = undefined;
    const raw = await this.getSnapshot();
    const els = parseElements(raw);
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
      const firstPerRegion = new Map<number, string>();
      regions.forEach((rid, i) => {
        if (typeof rid === "number" && rid >= 0 && !firstPerRegion.has(rid)) {
          firstPerRegion.set(rid, candidates[i]!.name.trim());
        }
      });
      return new Set([...firstPerRegion.values()].slice(0, MAX_PROMOTED_CLICKABLES));
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
    this.snapshotCache = undefined;
    this.initialUrl = undefined;
    this.lastRaw = undefined;
    this.lastClickable = undefined;
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {}); // also kill the subprocess on partial/abnormal state
  }

  async locate(target: Target): Promise<Target> {
    const rows = parseSnapshotRows(await this.getSnapshot());
    const uid = resolveTargetUid(rows, target);
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

  private async resolveUid(target: Target): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const rows = parseSnapshotRows(await this.getSnapshot());
      const uid =
        (target.selector ? await this.resolveSelectorUid(rows, target.selector) : undefined) ??
        resolveTargetUid(rows, target);
      if (uid) return uid;
      if (attempt >= RESOLVE_RETRIES) {
        throw new Error(describeResolutionMiss(rows, target));
      }
      this.snapshotCache = undefined; // re-fetch — the element may render on a later frame
      await delay(RESOLVE_RETRY_MS);
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

/** True if an MCP error means a click opened a JS dialog (confirm/alert/prompt) that now blocks. */
export function isOpenDialog(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /open dialog/i.test(m) || /handle_dialog/i.test(m);
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
