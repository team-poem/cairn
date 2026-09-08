import { stepError } from "./errors.js";
import { onSiteOf } from "./requests.js";
import type { PageElement, Step } from "./types.js";

/** A value a `type` step fills in for a `{name}` placeholder at run time (#174). Scoped form:
 * the secret belongs to one site (host or a subdomain of it; the port when one is given) and
 * the engine refuses to type it anywhere else. */
export type Secret = string | { value: string; origin: string };
export type Secrets = Readonly<Record<string, Secret>>;

/** `{name}`: a bare identifier in braces. Nothing else is a placeholder, so typed JSON
 * (`{"a":1}`) or a regex quantifier passes through. `{{name}}` is the escape: it types the
 * literal `{name}`, for a form that really wants braces (a template key, a Slack mention). */
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_-]*)\}/g;
const ESCAPED = /\{\{([A-Za-z][A-Za-z0-9_-]*)\}\}/g;

export function hasSecretPlaceholder(text: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(text.replace(ESCAPED, ""));
}

const valueOf = (s: Secret) => (typeof s === "string" ? s : s.value);

/** origin+path of a page, never its query or hash: a provider callback URL carries session and
 * state tokens, and a refusal message travels into the trace and the prompt. */
function shownUrl(url: string | undefined): string {
  if (url === undefined) return "an unknown page";
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.replace(/[?#].*$/, "");
  }
}

/** The port a URL is actually served on: the explicit one, else the scheme's default. */
function effectivePort(u: URL): string {
  return u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
}

/** The #184 site check (host or subdomain), plus the port when the origin names one: two apps
 * on one host differ by port, and a credential for `localhost:3000` is not `localhost:4000`'s.
 * "Names one" is read from the text, since `URL.port` erases an explicit default (`:80`). */
function onSecretSite(origin: string, pageUrl: string): boolean {
  if (!onSiteOf(origin, pageUrl)) return false;
  try {
    const withScheme = /^https?:\/\//i.test(origin) ? origin : `https://${origin}`;
    const named = /^[a-z]+:\/\/[^/]*:\d+(?:[/?#]|$)/i.test(withScheme);
    return !named || effectivePort(new URL(withScheme)) === effectivePort(new URL(pageUrl));
  } catch {
    return false;
  }
}

/**
 * Resolve every `{name}` in `text` from `secrets`, for the driver only — the frozen step keeps the
 * placeholder, so a skill file never carries a credential (#174). Fails closed twice: a placeholder
 * with no value is the host's wiring (`handler`, exit 4: pass it), and a scoped secret asked for
 * on a page outside its site is refused outright — the flow left the app, and a credential is
 * the one input where following it is harmful, not merely off-task.
 */
export function fillSecrets(text: string, secrets: Secrets = {}, pageUrl?: string): string {
  const filled = text.replace(ESCAPED, (_m, name: string) => `\u0000${name}\u0000`).replace(PLACEHOLDER, (_m, name: string) => {
    const secret = secrets[name];
    if (secret === undefined) {
      throw Object.assign(
        stepError("handler", `secret {${name}} is not provided — pass it in \`secrets\` (or --secret ${name}=…); type a literal {${name}} as {{${name}}}`),
        { secretName: name },
      );
    }
    if (typeof secret === "string") return secret;
    if (pageUrl === undefined || !onSecretSite(secret.origin, pageUrl)) {
      throw new Error(`secret {${name}} belongs to ${secret.origin} and is refused on ${shownUrl(pageUrl)}`);
    }
    return secret.value;
  });
  return filled.replace(/\u0000([A-Za-z][A-Za-z0-9_-]*)\u0000/g, "{$1}");
}

/** The name of the secret a `fillSecrets` failure was about, or undefined for any other error. */
export function missingSecretOf(err: unknown): string | undefined {
  const name = (err as { secretName?: unknown } | null)?.secretName;
  return typeof name === "string" ? name : undefined;
}

/**
 * A page rendered for the model must not show a secret the driver just typed: an
 * `<input type="password">` is masked by the browser, but a username, a token, an OTP, or a
 * password field a site implements as plain text comes back in the a11y snapshot verbatim one
 * turn later. Only `value` is masked. An accessible NAME is the page's own text and the model's
 * handle on the element: masking "Continue as alice@example.com" to "Continue as {user}" would
 * send the model a name the driver cannot locate. A page that prints a secret in a label shows
 * it to anyone; the engine's job is not to add a second copy through the field it typed into.
 */
export function redactSecrets<T extends PageElement>(elements: readonly T[], secrets: Secrets = {}): T[] {
  const entries = secretEntries(secrets);
  if (entries.length === 0) return [...elements];
  return elements.map((e) => {
    if (e.value === undefined) return e;
    const value = slotOnePass(e.value, entries);
    return value === e.value ? e : { ...e, value };
  });
}

/** Provided secrets as `[name, value]`, longest value first so a value that contains another
 * (`alice@example.com` and `alice`) is slotted whole, never as `{user}@example.com`. */
function secretEntries(secrets: Secrets): (readonly [string, string])[] {
  return Object.entries(secrets)
    .map(([name, s]) => [name, valueOf(s)] as const)
    .filter(([, v]) => v.length > 0)
    .sort((a, b) => b[1].length - a[1].length);
}

const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One left-to-right pass over `text`: at each position the longest provided secret value wins,
 * else an existing `{{escape}}` or `{name}` is kept verbatim, else one literal character. A
 * generated `{name}` is emitted, never re-scanned, so a later value cannot rewrite it; a value
 * that itself contains braces (`abc{xyz}`) is matched whole, before any brace is read as syntax.
 */
function slotOnePass(text: string, entries: readonly (readonly [string, string])[]): string {
  if (entries.length === 0) return text;
  const alternation = [
    ...entries.map(([, v]) => escapeRe(v)),
    "\\{\\{[A-Za-z][A-Za-z0-9_-]*\\}\\}",
    "\\{[A-Za-z][A-Za-z0-9_-]*\\}",
  ].join("|");
  const re = new RegExp(alternation, "g");
  return text.replace(re, (m) => {
    const hit = entries.find(([, v]) => v === m);
    return hit ? `{${hit[0]}}` : m;
  });
}

/** `text` with every provided secret value replaced by its `{name}`, existing placeholders and
 * `{{escapes}}` untouched, in a single pass (see `slotOnePass`). */
export function slotSecretText(text: string, secrets: Secrets = {}): string {
  return slotOnePass(text, secretEntries(secrets));
}

/**
 * A `type` step whose text carries a provided secret's value gets the placeholder back. The model
 * may echo a literal it saw in a text field instead of the `{name}` the intent used; the engine
 * knows the exact value, so the substitution is unambiguous. Applied at decision time
 * (`applyDecision`), before the step is executed, retained, traced, or shown to the model again —
 * so a literal echo also goes through the scope check and never reaches a sink. In place.
 */
export function slotSecrets(steps: Step[], secrets: Secrets = {}): void {
  for (const step of steps) {
    if (step.kind === "type") step.text = slotSecretText(step.text, secrets);
  }
}

/**
 * The scope check on what the driver is about to type, whichever path produced it: a scoped
 * secret's value that arrived through a placeholder, through `{{escape}}` decoding, or as a
 * literal the model echoed must equally be refused off its site (#174). Throws the same refusal
 * as `fillSecrets`; a no-op when no scoped value is present.
 */
export function assertSecretScope(output: string, secrets: Secrets = {}, pageUrl?: string): void {
  for (const [name, secret] of Object.entries(secrets)) {
    if (typeof secret === "string" || secret.value.length === 0 || !output.includes(secret.value)) continue;
    if (pageUrl === undefined || !onSecretSite(secret.origin, pageUrl)) {
      throw new Error(`secret {${name}} belongs to ${secret.origin} and is refused on ${shownUrl(pageUrl)}`);
    }
  }
}

/** Does `secrets` hold any scoped value that `text` could produce once filled? Cheap gate for the
 * extra page observation the scope check needs. */
export function mayCarryScopedSecret(text: string, secrets: Secrets = {}): boolean {
  if (hasSecretPlaceholder(text)) return Object.values(secrets).some((s) => typeof s !== "string");
  const decoded = fillSecrets(text, secrets);
  return Object.values(secrets).some((s) => typeof s !== "string" && s.value.length > 0 && decoded.includes(s.value));
}
