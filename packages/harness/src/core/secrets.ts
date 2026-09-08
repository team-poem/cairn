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
    const value = entries.reduce((t, [name, v]) => (t.includes(v) ? t.split(v).join(`{${name}}`) : t), e.value);
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

/** `text` with every provided secret value replaced by its `{name}`, leaving existing
 * placeholders and `{{escapes}}` untouched: the replacement runs only over literal spans, so a
 * value that happens to be a substring of a placeholder's own name (`word` in `{password}`) is
 * never rewritten. */
export function slotSecretText(text: string, secrets: Secrets = {}): string {
  const entries = secretEntries(secrets);
  if (entries.length === 0) return text;
  const spans = text.split(/(\{\{[A-Za-z][A-Za-z0-9_-]*\}\}|\{[A-Za-z][A-Za-z0-9_-]*\})/);
  return spans
    .map((span, i) => (i % 2 === 1 ? span : entries.reduce((t, [name, value]) => (t.includes(value) ? t.split(value).join(`{${name}}`) : t), span)))
    .join("");
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
