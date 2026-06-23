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

export interface ChromeDriverOptions {
  command?: string;
  args?: string[];
}

export class ChromeDevToolsDriver implements Driver {
  private client?: Client;
  private transport?: StdioClientTransport;
  private initialUrl?: string;

  constructor(private readonly opts: ChromeDriverOptions = {}) {}

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: "cairn-harness", version: "0.0.0" }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: this.opts.command ?? MCP_COMMAND,
      args: this.opts.args ?? MCP_ARGS,
    });
    await client.connect(transport);
    this.client = client;
    this.transport = transport;
    return client;
  }

  private async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const client = await this.ensureConnected();
    const res = (await client.callTool({ name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (res.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    if (res.isError) throw new Error(`MCP ${name} failed: ${text}`);
    return text;
  }

  async goto(url: string): Promise<void> {
    if (this.initialUrl === undefined) this.initialUrl = url;
    await this.call("navigate_page", { type: "url", url });
  }

  async click(target: Target): Promise<void> {
    await this.call("click", { uid: await this.resolveUid(target) });
  }

  async doubleClick(target: Target): Promise<void> {
    await this.call("click", { uid: await this.resolveUid(target), dblClick: true });
  }

  async hover(target: Target): Promise<void> {
    await this.call("hover", { uid: await this.resolveUid(target) });
  }

  async type(target: Target, text: string): Promise<void> {
    await this.call("fill", { uid: await this.resolveUid(target), value: text });
  }

  async select(target: Target, value: string): Promise<void> {
    // chrome-devtools-mcp's `fill` selects an option when the element is a <select>.
    await this.call("fill", { uid: await this.resolveUid(target), value });
  }

  async pressKey(key: string): Promise<void> {
    await this.call("press_key", { key });
  }

  async scroll(direction: "down" | "up" = "down"): Promise<void> {
    const sign = direction === "up" ? "-" : "";
    await this.call("evaluate_script", {
      function: `() => { window.scrollBy(0, ${sign}window.innerHeight * 0.9); }`,
    });
  }

  async snapshot(): Promise<PageElement[]> {
    return parseElements(await this.call("take_snapshot"));
  }

  async settle(options: SettleOptions = {}): Promise<void> {
    // Chrome defers low-priority resources (favicon, web fonts) past the usual 500ms
    // "network-idle" window, so the idle threshold is generous — missing a late request
    // would mean missing a real failure. Tune via SettleOptions.
    const idleMs = options.idleMs ?? 1_000;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const pollMs = options.pollMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    let lastCount = -1;
    let stableSince = Date.now();
    try {
      while (Date.now() < deadline) {
        const count = parseNetwork(await this.call("list_network_requests")).length;
        if (count !== lastCount) {
          lastCount = count;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= idleMs) {
          return; // count held steady long enough — treat as network-idle
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
    await this.client?.close().catch(() => {});
    this.client = undefined;
    this.transport = undefined;
  }

  private async resolveUid(target: Target): Promise<string> {
    if (target.selector) {
      throw new Error("ChromeDevToolsDriver resolves targets by text, not CSS selector");
    }
    if (!target.text) throw new Error("target needs a `text` to resolve an element");
    const uid = findUidByName(await this.call("take_snapshot"), target.text);
    if (!uid) throw new Error(`no element with accessible name matching "${target.text}"`);
    return uid;
  }
}

// --- parsers for chrome-devtools-mcp's text output -------------------------------

/** `uid=1_3 link "Learn more" …` → {role:"link", name:"Learn more"} for named rows. */
export function parseElements(snapshot: string): PageElement[] {
  const out: PageElement[] = [];
  for (const line of snapshot.split("\n")) {
    const m = line.match(/uid=\S+\s+(\w+)\s+"([^"]*)"/);
    if (m && m[2]!.trim()) out.push({ role: m[1]!, name: m[2]! });
  }
  return out;
}

/**
 * Resolve a uid by accessible name. Prefers an exact (case-insensitive) match over a
 * substring one, so "Cart" picks the button "Cart" rather than the first "Add to Cart".
 * Only the role-adjacent quoted name counts — a bare `url="…"` is never matched as a name.
 */
export function findUidByName(snapshot: string, text: string): string | undefined {
  const needle = text.trim().toLowerCase();
  const rows: Array<{ uid: string; name: string }> = [];
  for (const line of snapshot.split("\n")) {
    const m = line.match(/uid=(\S+)\s+\w+\s+"([^"]*)"/);
    if (m && m[2]!.trim()) rows.push({ uid: m[1]!, name: m[2]! });
  }
  return (
    rows.find((r) => r.name.toLowerCase() === needle)?.uid ??
    rows.find((r) => r.name.toLowerCase().includes(needle))?.uid
  );
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

/** Console listing → messages. Conservative: only rows naming a known type. */
export function parseConsole(text: string): ConsoleMessage[] {
  const out: ConsoleMessage[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:msgid=\d+\s+)?(log|debug|info|error|warn|trace|verbose)[:>\s]\s*(.*)$/i);
    if (m) out.push({ type: m[1]!.toLowerCase(), text: m[2]!.trim() });
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
