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

/** The #184 site check (host or subdomain), plus the port when the origin names one: two apps
 * on one host differ by port, and a credential for `localhost:3000` is not `localhost:4000`'s. */
function onSecretSite(origin: string, pageUrl: string): boolean {
  if (!onSiteOf(origin, pageUrl)) return false;
  try {
    const o = new URL(/^https?:\/\//i.test(origin) ? origin : `https://${origin}`);
    return o.port === "" || o.port === new URL(pageUrl).port;
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
 * turn later. Any element name or value equal to a provided secret reads as its placeholder.
 */
export function redactSecrets<T extends PageElement>(elements: readonly T[], secrets: Secrets = {}): T[] {
  const entries = Object.entries(secrets).map(([name, s]) => [name, valueOf(s)] as const).filter(([, v]) => v.length > 0);
  if (entries.length === 0) return [...elements];
  const mask = (text: string) => entries.reduce((t, [name, value]) => (t.includes(value) ? t.split(value).join(`{${name}}`) : t), text);
  return elements.map((e) => {
    const name = mask(e.name);
    const value = e.value === undefined ? undefined : mask(e.value);
    return name === e.name && value === e.value ? e : { ...e, name, ...(value === undefined ? {} : { value }) };
  });
}

/**
 * Before a freeze: a `type` step whose text contains a provided secret's value gets the
 * placeholder back. The model may echo a literal it saw in a text field instead of the `{name}`
 * the intent used; the engine knows the exact value, so the substitution is unambiguous and a
 * skill never carries it. In place, on the steps that will be frozen.
 */
export function slotSecrets(steps: Step[], secrets: Secrets = {}): void {
  const entries = Object.entries(secrets).map(([name, s]) => [name, valueOf(s)] as const).filter(([, v]) => v.length > 0);
  if (entries.length === 0) return;
  for (const step of steps) {
    if (step.kind !== "type") continue;
    for (const [name, value] of entries) {
      if (step.text.includes(value)) step.text = step.text.split(value).join(`{${name}}`);
    }
  }
}
