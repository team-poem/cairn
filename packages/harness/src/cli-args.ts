export type Flags = Map<string, string | boolean>;

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
        flags.set(arg.slice(2, equalsIndex), arg.slice(equalsIndex + 1));
        continue;
      }

      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
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
