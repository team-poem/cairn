/** Canonical hostname with an explicit port, or a full URL's protocol for its default port. */
export interface HostIdentity {
  hostname: string;
  port?: string;
  protocol?: string;
}

/** Parse a configured/bare authority. Preserve explicit 80/443 instead of letting URL strip it. */
export function parseHostAuthority(authority: string): HostIdentity | undefined {
  if (typeof authority !== "string" || !authority || /[\s/\\?#@*]/.test(authority)) return undefined;
  const parts = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority);
  if (!parts) return undefined;
  try {
    const url = new URL(`http://${authority}`);
    if (!url.hostname || url.username || url.password || url.pathname !== "/") return undefined;
    return { hostname: url.hostname, port: parts[2] === undefined ? undefined : String(Number(parts[2])) };
  } catch {
    return undefined;
  }
}

export function hostAuthority(host: HostIdentity): string {
  return `${host.hostname}${host.port === undefined ? "" : `:${host.port}`}`;
}

export interface ReplayUrl {
  host: HostIdentity;
  absolute: boolean;
  suffix: string;
}

/** Full HTTP(S) URLs and frozen bare host+path forms share host spelling, not default-port guesses. */
export function parseReplayUrl(value: string): ReplayUrl | undefined {
  if (value !== value.trim() || value.includes("\\")) return undefined;
  const parts = /^(https?:\/\/)?([^/?#]+)([/?#].*)?$/i.exec(value);
  if (!parts) return undefined;
  const suffix = parts[3] ?? "";
  if (!parts[1]) {
    const host = parseHostAuthority(parts[2]!);
    return host ? { host, absolute: false, suffix } : undefined;
  }
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    return { host: { hostname: url.hostname, port: url.port || undefined, protocol: url.protocol }, absolute: true, suffix };
  } catch {
    return undefined;
  }
}

/** A declared explicit port matches a full URL's effective port, including its protocol default.
 * A bare frozen authority with no port/protocol may have come from either HTTP(S) default.
 * An omitted scope port matches omitted ports, never a known non-default port. */
export function hostIsAllowed(host: HostIdentity, allowedHosts: readonly string[]): boolean {
  const effectivePort = host.port ?? (host.protocol === "https:" ? "443" : host.protocol === "http:" ? "80" : undefined);
  return allowedHosts.some((authority) => {
    const scope = parseHostAuthority(authority);
    if (!scope || scope.hostname !== host.hostname) return false;
    if (scope.port === undefined) return host.port === undefined;
    // destinationKey drops a URL's default port before freezing its bare host+path. The bare
    // key retains that default-port identity, but an actual/full URL still has its protocol.
    if (host.port === undefined && host.protocol === undefined) return scope.port === "80" || scope.port === "443";
    return scope.port === effectivePort;
  });
}
