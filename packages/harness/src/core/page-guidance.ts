/** Host page guidance bound to one decision observation (#304). Advice, never evidence or policy. */
import type { Driver, PageGuidanceElement, PageGuidanceProvider, PageGuidanceRequest } from "./ports.js";
import type { PageElement } from "./types.js";
import type { PerceptionObservation } from "./observation.js";
import { rethrowBudget, type BudgetScope } from "./budget.js";
import { combineSignals } from "./abort.js";
import { slotSecretText, type Secrets } from "./secrets.js";

export const MAX_PAGE_GUIDANCE_BYTES = 4096;
export const PAGE_GUIDANCE_TIMEOUT_MS = 5000;
/** Expirations allowed without a successfully executed action in one discover/explore call. */
export const MAX_PAGE_GUIDANCE_EXPIRATIONS = 3;

/** Separate from policy/scroll state. A new capture or a different failure is not progress. */
export class PageGuidanceAttempts {
  private expirations = 0;
  get exhausted(): boolean { return this.expirations >= MAX_PAGE_GUIDANCE_EXPIRATIONS; }
  expired(): void { this.expirations++; }
  executed(): void { this.expirations = 0; }
  diagnostic() {
    return { code: "page-guidance-expired" as const, expirations: this.expirations,
      limit: MAX_PAGE_GUIDANCE_EXPIRATIONS,
      reason: "page guidance expired repeatedly before an action could complete" };
  }
  recovery(hasReferences: boolean): string | undefined {
    if (!this.expirations) return undefined;
    return hasReferences
      ? 'After page guidance expires, a target-bearing action can use a fresh "ref" from the current element listing. ' +
        'Never reuse a previous ref. This does not bypass validation; done and note do not take refs.'
      : 'After page guidance expires, decide from the fresh observation below. No references are available; ' +
        'use the current exact name, role and nth when needed. Do not invent a ref.';
  }
}

/** Guidance accepted for one observation, with the URL its provider was given. */
export interface PageGuidance { text: string; url?: string }

export interface PageGuidanceContext {
  purpose: PageGuidanceRequest["purpose"];
  page: PerceptionObservation;
  url?: string;
  secrets?: Secrets;
  signal?: AbortSignal;
  scope?: BudgetScope;
  /** Fixed, content-free diagnostic for a gate event. */
  gate: (reason: string) => void;
}

/** Run-local comparison only: never publish raw values or a content-derived hash. Refs and
 * driver-local region IDs may rotate on a fresh capture without changing page semantics. */
export function pageGuidanceState(elements: readonly PageElement[]): string {
  return JSON.stringify(elements.map(e => [e.role, e.name, e.value, e.checked, e.disabled,
    e.inActivePopup, e.occluded, e.clickable]));
}

/** A ref-bearing action retains its exact Driver mutation guard. A reference-free decision
 * (including done/note) must compare a fresh capture before producing any effect. Recapture
 * invalidates Driver refs, so it must never run for a decision bound to an exact ref. */
export async function pageGuidanceInvalidation(driver: Driver, guidance: PageGuidance,
  capturedState: string, hasReference: boolean, signal?: AbortSignal,
  onUrl?: (url: string | undefined) => void): Promise<string | undefined> {
  const urlInvalidation = await pageGuidanceUrlInvalidation(driver, guidance, signal, onUrl);
  if (urlInvalidation) return urlInvalidation;
  if (!hasReference && pageGuidanceState(await readCurrent(() => driver.snapshot({ perception: true }), signal)) !== capturedState) {
    return "page guidance expired: the page elements changed after the guided observation";
  }
  // Capture and URL reads are separate. Detect navigation during this fresh capture too.
  return hasReference ? undefined : pageGuidanceUrlInvalidation(driver, guidance, signal, onUrl);
}

export async function pageGuidanceUrlInvalidation(driver: Driver, guidance: PageGuidance,
  signal?: AbortSignal, onUrl?: (url: string | undefined) => void): Promise<string | undefined> {
  const url = (await readCurrent(() => driver.observe(), signal)).execution.finalUrl;
  onUrl?.(url);
  return url !== guidance.url
    ? "page guidance expired: the page URL changed after the guided observation" : undefined;
}

async function readCurrent<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  try { return await read(); }
  finally { signal?.throwIfAborted(); }
}

const TIMED_OUT = Symbol("timed out");
const bytes = (text: string) => new TextEncoder().encode(text).length;

function view(page: PerceptionObservation, secrets?: Secrets): PageGuidanceElement[] {
  return page.listed.map(({ element: e, nth }) => ({
    role: e.role, name: slotSecretText(e.name, secrets),
    ...(nth !== undefined ? { nth } : {}), ...(e.checked !== undefined ? { checked: e.checked } : {}),
    ...(e.disabled !== undefined ? { disabled: e.disabled } : {}),
    ...(e.inActivePopup !== undefined ? { inActivePopup: e.inActivePopup } : {}),
  }));
}

// The engine stops waiting at the timeout; a late value is discarded, never applied to a later observation.
async function race(provider: PageGuidanceProvider, request: Omit<PageGuidanceRequest, "signal">, run?: AbortSignal): Promise<unknown> {
  const started = performance.now();
  const timeout = new AbortController();
  const { signal, dispose } = combineSignals(run ? [run, timeout.signal] : [timeout.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const settled = await new Promise<{ value: unknown } | { error: unknown }>((resolve, reject) => {
      if (run?.aborted) return reject(run.reason);
      timer = setTimeout(() => { timeout.abort(); resolve({ value: TIMED_OUT }); }, PAGE_GUIDANCE_TIMEOUT_MS);
      cancel = () => reject(run!.reason);
      run?.addEventListener("abort", cancel, { once: true });
      Promise.resolve().then(() => provider({ ...request, signal }))
        .then(value => resolve({ value }), error => resolve({ error }));
    });
    // Synchronous providers and busy event loops can settle before an overdue timer runs.
    // Expire either settlement when control returns; JavaScript cannot interrupt the callback.
    run?.throwIfAborted();
    if (performance.now() - started >= PAGE_GUIDANCE_TIMEOUT_MS) {
      timeout.abort();
      return TIMED_OUT;
    }
    if ("error" in settled) throw settled.error;
    return settled.value;
  } finally {
    clearTimeout(timer);
    if (cancel) run?.removeEventListener("abort", cancel);
    dispose();
  }
}

/** Called after capture, perception and reference issuance, before the decision prompt.
 * Fails open to "no guidance"; cancellation and budget exhaustion propagate. */
export async function requestPageGuidance(provider: PageGuidanceProvider, ctx: PageGuidanceContext): Promise<PageGuidance | undefined> {
  const url = ctx.url === undefined ? undefined : slotSecretText(ctx.url, ctx.secrets);
  const request = { purpose: ctx.purpose, observationId: ctx.page.id, ...(url !== undefined ? { url } : {}),
    elements: view(ctx.page, ctx.secrets) };
  let value: unknown;
  try {
    value = ctx.scope
      ? await ctx.scope.operation("page-guidance.provide", () => race(provider, request, ctx.signal))
      : await race(provider, request, ctx.signal);
  } catch (error) {
    rethrowBudget(error);
    ctx.signal?.throwIfAborted();
    ctx.gate("page guidance unavailable: provider failed");
    return undefined;
  }
  ctx.signal?.throwIfAborted();
  if (value === TIMED_OUT) {
    ctx.gate("page guidance unavailable: provider timed out");
    return undefined;
  }
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    ctx.gate("page guidance rejected: provider output is not a string");
    return undefined;
  }
  // Match secrets against the untrimmed text, then bound what would actually be sent.
  const slotted = slotSecretText(value, ctx.secrets);
  if (value.length > MAX_PAGE_GUIDANCE_BYTES || bytes(value) > MAX_PAGE_GUIDANCE_BYTES || bytes(slotted) > MAX_PAGE_GUIDANCE_BYTES) {
    ctx.gate(`page guidance rejected: output exceeds ${MAX_PAGE_GUIDANCE_BYTES} UTF-8 bytes`);
    return undefined;
  }
  const text = slotted.trim();
  return text ? { text, url: ctx.url } : undefined;
}
