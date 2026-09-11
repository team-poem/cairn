import { validateReplayEnvironment } from "./index.js";
import type { ReplayEnvironment } from "./index.js";

export type Flags = Map<string, string | boolean | string[]>;

/** Flags that may be given more than once; each value is kept, in order. */
const REPEATABLE: ReadonlySet<string> = new Set(["secret", "secret-origin"]);

function setFlag(flags: Flags, key: string, value: string | boolean): void {
  if (REPEATABLE.has(key)) {
    const prev = flags.get(key);
    if (typeof value !== "string") {
      // A bare `--secret` must not wipe the values given before it; it is reported as usage later.
      if (prev === undefined) flags.set(key, true);
      return;
    }
    flags.set(key, Array.isArray(prev) ? [...prev, value] : typeof prev === "string" ? [prev, value] : [value]);
    return;
  }
  flags.set(key, value);
}

export function parseArgs(argv: string[]): {
  positionals: string[];
  flags: Flags;
} {
  const positionals: string[] = [];
  const flags: Flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const equalsIndex = arg.indexOf("=");
      if (equalsIndex >= 0) {
        setFlag(flags, arg.slice(2, equalsIndex), arg.slice(equalsIndex + 1));
        continue;
      }

      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        setFlag(flags, key, next);
        i++;
      } else {
        setFlag(flags, key, true);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

export const flagStr = (flags: Flags, key: string): string | undefined => {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
};

/** A positive-integer flag (e.g. --max-steps, --expect-timeout). Absent → undefined so the
 * library default applies; present but not a positive integer → a clear error, not NaN deep
 * in the run. */
export const flagNum = (flags: Flags, key: string): number | undefined => {
  const value = flags.get(key);
  if (value === undefined) return undefined;
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--${key} expects a positive integer, got ${JSON.stringify(value)}`);
  }
  return n;
};

/** Paired runtime flags; suite keeps --base-url for its canonical discovery identity. */
export function flagReplayEnvironment(flags: Flags, baseFlag = "base-url"): ReplayEnvironment | undefined {
  if (!flags.has(baseFlag) && !flags.has("allowed-hosts")) return undefined;
  const baseUrl = flagStr(flags, baseFlag);
  const hosts = flagStr(flags, "allowed-hosts");
  if (!baseUrl?.trim()) throw new Error(`--${baseFlag} requires an HTTP(S) origin with --allowed-hosts`);
  if (!hosts?.trim()) throw new Error(`--allowed-hosts requires a comma-separated host list with --${baseFlag}`);
  if (flags.has("freeze")) throw new Error("--freeze cannot be combined with a replay environment; repairs are temporary");
  try {
    return validateReplayEnvironment({ baseUrl, allowedHosts: hosts.split(",").map((host) => host.trim()) });
  } catch (err) {
    throw new Error(`--${baseFlag} / --allowed-hosts: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Every value of a repeatable flag (`--secret a=1 --secret b=2`), or `[]`. */
export const flagList = (flags: Flags, key: string): string[] => {
  const value = flags.get(key);
  return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
};
