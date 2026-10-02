import { stepError } from "../../core/errors.js";
import type { NetworkRequest } from "../../core/types.js";

/** MCP request IDs are stable across navigations, but local to a page's collector. */
export function networkRows(text: string): { id: string; request: NetworkRequest }[] {
  const rows: { id: string; request: NetworkRequest }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^reqid=(\d+)\s+(\w+)\s+(\S+)\s+\[([^\]]+)\]/);
    if (m) rows.push({ id: m[1]!, request: {
      method: m[2]!, url: m[3]!, status: /^\d+$/.test(m[4]!) ? Number(m[4]) : 0,
    } });
  }
  return rows;
}

/** Driver-session log: append new IDs, update statuses in place, never move a watermark.
 * MCP's preserved window can evict rows; absence does not erase previously observed evidence.
 * Unseen/evicted responses remain unknown, never reconstructed from URLs or page outcomes. */
export class ChromeNetworkLog {
  private readonly requests = new Map<string, NetworkRequest>();

  collect(pages: string, network: string): void {
    const page = pages.match(/^\s*(\d+):[^\n]*\s\[selected\](?:\s|$)/m)?.[1];
    const rows = networkRows(network);
    if (page === undefined && rows.length) throw stepError("transport", "network evidence has no selected page identity");
    for (const { id, request } of rows) {
      const key = `${page}:${id}`;
      const previous = this.requests.get(key);
      if (previous && (previous.method !== request.method || previous.url !== request.url)) {
        throw stepError("transport", "MCP reused a network request identity within the browser session");
      }
      // Concurrent reads can finish out of order; a stale pending row must not erase a response.
      if (!previous || request.status !== 0 || previous.status === 0) this.requests.set(key, request);
    }
  }

  get size(): number { return this.requests.size; }

  snapshot(): NetworkRequest[] {
    // Old Evidence values and caller mutations cannot change the live log.
    return [...this.requests.values()].map(request => ({ ...request }));
  }

  clear(): void { this.requests.clear(); }
}
