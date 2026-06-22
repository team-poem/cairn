/**
 * Default Driver — drives a real browser through the Chrome DevTools MCP server.
 *
 * The harness embeds an MCP *client* and spawns `chrome-devtools-mcp` over stdio, so
 * `cairn run` is self-contained (no external agent needed). The core stays
 * driver-agnostic (invariant #5): everything Chrome-specific — tool names, text-response
 * parsing — lives here, behind the Driver interface.
 *
 * The MCP returns human-readable text, not JSON, so this driver parses the same lines a
 * human sees (snapshot uids, `reqid=… GET … [200]`, the selected-page url).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Driver } from "../interfaces.js";
import type {
  ConsoleMessage,
  Evidence,
  NetworkRequest,
  PageElement,
  SettleOptions,
  Target,
} from "../types.js";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const MCP_COMMAND = "npx";
// `--isolated` gives the harness its own ephemeral browser instance, so a standalone
// `cairn run` never collides with another chrome-devtools-mcp using the default profile.
const MCP_ARGS = ["-y", "chrome-devtools-mcp@latest", "--isolated"];

export interface ChromeDriverOptions {
  /** Override the command used to launch the MCP server (e.g. a pinned version). */
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

  /** Call an MCP tool and return its text content joined. */
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
    const uid = await this.resolveUid(target);
    await this.call("click", { uid });
  }

  async type(target: Target, text: string): Promise<void> {
    const uid = await this.resolveUid(target);
    await this.call("fill", { uid, value: text });
  }

  async snapshot(): Promise<PageElement[]> {
    const text = await this.call("take_snapshot");
    return parseElements(text);
  }

  async settle(options: SettleOptions = {}): Promise<void> {
    // Chrome defers low-priority resources (favicon, web fonts) well past the usual
    // 500ms "network-idle" window, so the idle threshold is deliberately generous —
    // missing a late request would mean missing a real failure. Tune via SettleOptions.
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
          return; // request count held steady long enough — treat as network-idle
        }
        await delay(pollMs);
      }
    } catch {
      // best-effort: settling must never fail a run (interface contract).
    }
  }

  async observe(): Promise<Evidence> {
    const [pages, network, console] = await Promise.all([
      this.call("list_pages"),
      this.call("list_network_requests"),
      this.call("list_console_messages"),
    ]);

    const finalUrl = parseSelectedUrl(pages);
    const navigated = finalUrl !== undefined && finalUrl !== this.initialUrl;

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

  /** Take an a11y snapshot and find the uid whose accessible name matches the target. */
  private async resolveUid(target: Target): Promise<string> {
    if (target.selector) {
      throw new Error("ChromeDevToolsDriver v0 resolves targets by text, not CSS selector");
    }
    if (!target.text) throw new Error("target needs a `text` to resolve an element");
    const snapshot = await this.call("take_snapshot");
    const uid = findUidByName(snapshot, target.text);
    if (!uid) throw new Error(`no element with accessible name matching "${target.text}"`);
    return uid;
  }
}

// --- text parsers for chrome-devtools-mcp output ---------------------------------

/** `uid=1_3 link "Learn more" …` → {role:"link", name:"Learn more"} for named rows. */
export function parseElements(snapshot: string): PageElement[] {
  const out: PageElement[] = [];
  for (const line of snapshot.split("\n")) {
    const m = line.match(/uid=\S+\s+(\w+)\s+"([^"]*)"/);
    if (m && m[2]!.trim()) out.push({ role: m[1]!, name: m[2]! });
  }
  return out;
}

/** `uid=1_3 link "Learn more" url="..."` → first uid whose quoted name includes `text`. */
export function findUidByName(snapshot: string, text: string): string | undefined {
  const needle = text.toLowerCase();
  for (const line of snapshot.split("\n")) {
    const uidMatch = line.match(/uid=(\S+)/);
    if (!uidMatch) continue;
    const nameMatch = line.match(/"([^"]*)"/);
    if (nameMatch && nameMatch[1]!.toLowerCase().includes(needle)) {
      return uidMatch[1];
    }
  }
  return undefined;
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

/** Console listing → messages. Conservative: only rows that name a known type. */
export function parseConsole(text: string): ConsoleMessage[] {
  const out: ConsoleMessage[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:msgid=\d+\s+)?(log|debug|info|error|warn|trace|verbose)[:>\s]\s*(.*)$/i);
    if (m) out.push({ type: m[1]!.toLowerCase(), text: m[2]!.trim() });
  }
  return out;
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
