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
