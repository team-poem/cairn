/** Versioned, browser-safe identity of declared judgment inputs (#196). No model or I/O. */
import type { ContractIdentity, Scenario, ScenarioProvenance } from "./types.js";
import type { RequestMatchOptions } from "./requests.js";
import { DEFAULT_LOCALE_PREFIXES } from "./steps.js";

export interface JudgmentOptions {
  benign?: readonly string[];
  benignConsole?: readonly string[];
  localePrefixes?: readonly string[];
  requestMatch?: RequestMatchOptions;
  /** Version of host checks, evidence interpretation, or semantic judge configuration.
   * Change it whenever those semantics change. Not a credential or raw configuration. */
  judgmentKey?: string;
  /** Effective Context.intent passed to a semantic/injected critic, not authoring intent.
   * null means explicitly absent; undefined means not captured (identity stays incomplete). */
  judgmentIntent?: string | null;
  /** The judge has semantics the engine cannot inspect. Without a key, comparisons are unknown. */
  opaque?: boolean;
}

export interface IdentifyScenarioOptions extends JudgmentOptions {
  /** Explicit authoring intent. Omit to preserve a recorded intent hash; never infer from name. */
  intent?: string;
  /** Host-declared provenance only; this does not load or inject app context (#282). */
  provenance?: ScenarioProvenance;
}

/** Stable JSON: sorted object keys, ordered arrays, omitted undefined object properties.
 * Reject non-JSON values rather than silently creating identity collisions. */
class ContractValueError extends Error {}

function canonical(value: unknown, parents = new Set<object>(), strict = false): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value) && !(strict && Object.is(value, -0))) return JSON.stringify(value);
  if (typeof value !== "object" || parents.has(value)) throw new ContractValueError("Contract inputs must be finite, acyclic JSON values");
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new ContractValueError("Contract inputs must be plain JSON objects");
  // A custom check sees the original object, not JSON.stringify's lossy projection. Do not
  // invoke accessors or erase observable fields when claiming a complete identity for params.
  if (strict) for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined)
      throw new ContractValueError("Contract inputs must have plain JSON data properties");
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key))
      throw new ContractValueError("Contract inputs must not have extra array properties");
  }
  parents.add(value);
  let out: string;
  if (Array.isArray(value)) {
    out = `[${Array.from(value, v => canonical(v, parents, strict)).join(",")}]`;
  } else {
    const record = value as Record<string, unknown>;
    out = `{${Object.keys(record).sort().filter(k => record[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonical(record[k], parents, strict)}`).join(",")}}`;
  }
  parents.delete(value);
  return out;
}

/** UTF-8 SHA-256; same implementation on the Node and browser entry points. */
export async function hashContractValue(value: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (typeof subtle?.digest !== "function") throw new Error("WebCrypto SHA-256 is unavailable in this execution context");
  const bytes = new TextEncoder().encode(canonical(value));
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function isContractIdentity(value: unknown): value is ContractIdentity {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<ContractIdentity>;
  return v.version === 1 && hash(v.fingerprint) && typeof v.complete === "boolean"
    && (v.intentHash === undefined || hash(v.intentHash)) && (!v.complete || hash(v.intentHash));
}

/** Invalid, missing and future-version records never compare equal by accident. */
export function compareContracts(a: unknown, b: unknown): "same" | "changed" | "unknown" {
  if (!isContractIdentity(a) || !isContractIdentity(b) || !a.complete || !b.complete) return "unknown";
  return a.fingerprint === b.fingerprint ? "same" : "changed";
}

/** Copy only the declared digest. Unknown/raw fields never leak into results or traces. */
export function copyProvenance(value: ScenarioProvenance | undefined): ScenarioProvenance | undefined {
  return hash(value?.appContextHash) ? { appContextHash: value.appContextHash } : undefined;
}

/** Compute from current assertions, never trust a possibly stale stored fingerprint. */
export async function scenarioContract(scenario: Scenario, opts: IdentifyScenarioOptions = {}): Promise<ContractIdentity> {
  const recordedIntentHash = opts.intent === undefined && isContractIdentity(scenario.contract) ? scenario.contract.intentHash : undefined;
  if (typeof globalThis.crypto?.subtle?.digest !== "function") {
    // Advisory identity must not block non-secure browser embedders. This is a reserved
    // unavailable marker, not a computed digest; never hash again in this fallback.
    return { version: 1, fingerprint: "0".repeat(64), complete: false,
      ...(recordedIntentHash ? { intentHash: recordedIntentHash } : {}) };
  }
  const intentHash = opts.intent !== undefined
    ? await hashContractValue(opts.intent)
    : recordedIntentHash;
  const opaque = opts.opaque || scenario.assertions.some(a => a.kind === "custom" || a.kind === "expect");
  const usesContext = opts.opaque || scenario.assertions.some(a => a.kind === "expect");
  const judgmentIntentHash = usesContext && typeof opts.judgmentIntent === "string"
    ? await hashContractValue(opts.judgmentIntent) : null;
  const judgmentKey = opts.judgmentKey?.trim() || undefined;
  const complete = intentHash !== undefined && (!opaque || judgmentKey !== undefined)
    && (!usesContext || opts.judgmentIntent !== undefined);
  const set = (values: readonly string[]) => [...new Set(values)].sort();
  let fingerprint: string;
  try {
    for (const assertion of scenario.assertions) {
      if (assertion.kind === "custom" && assertion.params !== undefined) canonical(assertion.params, new Set(), true);
    }
    fingerprint = await hashContractValue({
      version: 1,
      intentHash,
      assertions: scenario.assertions,
      wildcards: scenario.wildcards === true,
      judgment: {
        // Bump this revision when built-in judgment semantics change, not on every release.
        revision: 1,
        benign: set(opts.benign ?? []),
        benignConsole: set(opts.benignConsole ?? []),
        localePrefixes: set(opts.localePrefixes ?? DEFAULT_LOCALE_PREFIXES),
        allowedHosts: opts.requestMatch?.allowedHosts === undefined ? null : set(opts.requestMatch.allowedHosts),
        judgmentKey,
        ...(usesContext ? { judgmentIntentHash } : {}),
      },
    });
  } catch (error) {
    if (!(error instanceof ContractValueError)) throw error;
    // Metadata must not reject previously valid in-memory custom checks. This digest is only
    // an unavailable marker: complete:false ensures it can never compare as same or changed.
    fingerprint = await hashContractValue({ version: 1, intentHash, unavailable: true });
    return { version: 1, fingerprint, ...(intentHash ? { intentHash } : {}), complete: false };
  }
  return { version: 1, fingerprint, ...(intentHash ? { intentHash } : {}), complete };
}

/** Stamp a new freeze without mutating the caller's scenario or previous records. */
export async function identifyScenario<T extends Scenario>(scenario: T, opts: IdentifyScenarioOptions = {}): Promise<T & { contract: ContractIdentity }> {
  const provenance = copyProvenance(opts.provenance ?? scenario.provenance);
  return { ...scenario, contract: await scenarioContract(scenario, opts), provenance };
}
