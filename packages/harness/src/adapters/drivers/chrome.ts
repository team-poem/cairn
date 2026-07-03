/**
 * Default Driver — drives a real browser via the Chrome DevTools MCP server, which this
 * embeds as a client and spawns over stdio (so `cairn run` is self-contained). Everything
 * Chrome-specific, including parsing the MCP's human-readable text, stays here behind the
 * Driver port (invariant #5).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

export interface ChromeDriverOptions {
  command?: string;
  args?: string[];
  /** Per-MCP-call timeout (ms). A hung tool call rejects instead of wedging the run. Default 30s. */
  timeoutMs?: number;
  /** Timeout for the initial browser launch/connect (ms). Default 60s (first run may download). */
  connectTimeoutMs?: number;
}

export class ChromeDevToolsDriver implements Driver {
  private client?: Client;
  private transport?: StdioClientTransport;
  private initialUrl?: string;
  private snapshotCache?: string; // raw take_snapshot text, valid until the next action mutates the page
  private readonly seenPages = new Set<number>();

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
      const ids = parsePageIds(await this.call("list_pages"));
      const fresh = ids.filter((id) => !this.seenPages.has(id));
      ids.forEach((id) => this.seenPages.add(id));
      if (fresh.length) {
        await this.call("select_page", { pageId: Math.max(...fresh) });
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
    if (this.client) return this.client;
    const client = new Client({ name: "cairn-harness", version: "0.0.0" }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: this.opts.command ?? MCP_COMMAND,
      args: this.opts.args ?? MCP_ARGS,
    });
    // If the subprocess dies mid-run, drop the dead client so the next call reconnects.
    transport.onclose = () => {
      if (this.client === client) {
        this.client = undefined;
        this.transport = undefined;
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
    await this.followNewTab();
  }

  async doubleClick(target: Target): Promise<void> {
    await this.callAccepting("click", { uid: await this.resolveUid(target), dblClick: true });
    this.snapshotCache = undefined;
    await this.followNewTab();
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
    // chrome-devtools-mcp's `fill` selects an option when the element is a <select>.
    await this.callAccepting("fill", { uid: await this.resolveUid(target), value });
    this.snapshotCache = undefined;
    await this.settle();
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
    return parseElements(await this.getSnapshot());
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
    this.seenPages.clear();
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {}); // also kill the subprocess on partial/abnormal state
  }

  async locate(target: Target): Promise<Target> {
    const rows = parseSnapshotRows(await this.getSnapshot());
    const uid = resolveTargetUid(rows, target);
    if (!uid) return target; // can't enrich right now — freeze what we have
    const row = rows.find((r) => r.uid === uid)!;
    const index = rows.filter((r) => r.role === row.role).findIndex((r) => r.uid === uid);
    return { ...target, text: target.text ?? row.name, role: row.role, index };
  }

  private async resolveUid(target: Target): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const uid = resolveTargetUid(parseSnapshotRows(await this.getSnapshot()), target);
      if (uid) return uid;
      if (attempt >= RESOLVE_RETRIES) throw new Error(`no element matching ${JSON.stringify(target)}`);
      this.snapshotCache = undefined; // re-fetch — the element may render on a later frame
      await delay(RESOLVE_RETRY_MS);
    }
  }
}

// --- parsers for chrome-devtools-mcp's text output -------------------------------

/** True if an MCP error means a click opened a JS dialog (confirm/alert/prompt) that now blocks. */
export function isOpenDialog(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /open dialog/i.test(m) || /handle_dialog/i.test(m);
}

/** `uid=1_3 link "Learn more" …` → {role:"link", name:"Learn more"} for named rows. */
export function parseElements(snapshot: string): PageElement[] {
  const out: PageElement[] = [];
  for (const line of snapshot.split("\n")) {
    const m = line.match(/uid=\S+\s+(\w+)\s+"([^"]*)"/);
    if (m && m[2]!.trim()) out.push({ role: m[1]!, name: m[2]! });
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
 * Multi-locator resolution. Prefers the accessible name (exact over substring, role-aware if known).
 * If the name no longer matches, falls back to role + structural index so a renamed control still
 * resolves WITHOUT the LLM — but only when that fallback is unambiguous (P3): with several same-role
 * candidates a reorder would silently select the wrong element, so it yields nothing and lets
 * self-heal pick by intent instead.
 */
export function resolveTargetUid(rows: SnapshotRow[], target: Target): string | undefined {
  const roleOk = (r: SnapshotRow) => !target.role || r.role === target.role;
  if (target.text) {
    const needle = target.text.trim().toLowerCase();
    const exact = rows.find((r) => roleOk(r) && r.name.toLowerCase() === needle);
    if (exact) return exact.uid;
    // Substring fallback only when it's unambiguous — several partial matches is a guess (like the
    // positional guard below), so yield nothing and let self-heal pick by intent instead of mis-clicking.
    const subs = rows.filter((r) => roleOk(r) && r.name.trim() !== "" && r.name.toLowerCase().includes(needle));
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

/** Resolve a uid by accessible name only (exact over substring) — used by the discover snapshot path. */
export function findUidByName(snapshot: string, text: string): string | undefined {
  return resolveTargetUid(parseSnapshotRows(snapshot), { text });
}

/** `reqid=5 GET https://… [200]` → NetworkRequest[]. */
export function parseNetwork(text: string): NetworkRequest[] {
  const out: NetworkRequest[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^reqid=\d+\s+(\w+)\s+(\S+)\s+\[(\d+)\]/);
    if (m) out.push({ method: m[1]!, url: m[2]!, status: Number(m[3]) });
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

/** `4: Example Domain (…) [selected]` → page ids [4]. Ids are stable, increasing numbers. */
export function parsePageIds(text: string): number[] {
  const ids: number[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+):/);
    if (m) ids.push(Number(m[1]));
  }
  return ids;
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
