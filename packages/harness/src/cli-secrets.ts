import type { Secrets } from "./index.js";
import { flagList } from "./cli-args.js";
import type { Flags } from "./cli-args.js";

/** `CAIRN_SECRET_<NAME>` supplies `{name}` (lower-cased) when no `--secret name=…` did. Env names
 * cannot carry `-`, so a `{api-key}` placeholder is only reachable from the flag. */
const ENV_PREFIX = "CAIRN_SECRET_";

/**
 * Secrets for `{name}` placeholders (#174): `--secret name=value` (repeatable), `--secret-origin
 * name=https://app.example` to scope one to a site, and the environment for anything not given
 * on the command line — so a CI job keeps credentials in its secret store, never in a skill file
 * or a shell history line.
 */
export function secretsFromFlags(flags: Flags, env: NodeJS.ProcessEnv = process.env): Secrets | undefined {
  if (flags.get("secret") === true || flags.get("secret-origin") === true) {
    throw new Error("--secret expects name=value (and --secret-origin name=https://…)");
  }
  const values = new Map<string, string>();
  for (const pair of flagList(flags, "secret")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`--secret expects name=value, got ${JSON.stringify(pair)}`);
    values.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  const origins = new Map<string, string>();
  for (const pair of flagList(flags, "secret-origin")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`--secret-origin expects name=origin, got ${JSON.stringify(pair)}`);
    const origin = pair.slice(eq + 1);
    try {
      new URL(origin);
    } catch {
      throw new Error(`--secret-origin ${pair.slice(0, eq)}: expects a URL with a scheme (https://app.example), got ${JSON.stringify(origin)}`);
    }
    origins.set(pair.slice(0, eq), origin);
  }
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(ENV_PREFIX) || value === undefined) continue;
    const name = key.slice(ENV_PREFIX.length).toLowerCase();
    if (!values.has(name)) values.set(name, value);
  }
  for (const name of origins.keys()) {
    if (!values.has(name)) throw new Error(`--secret-origin ${name}: no value for {${name}} (pass --secret ${name}=… or ${ENV_PREFIX}${name.toUpperCase()})`);
  }
  if (values.size === 0) return undefined;
  const out: Record<string, Secrets[string]> = {};
  for (const [name, value] of values) {
    const origin = origins.get(name);
    out[name] = origin ? { value, origin } : value;
  }
  return out;
}
