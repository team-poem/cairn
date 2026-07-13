import { describe, expect, it } from "vitest";
import { dedupeFindings, deriveActionFindings } from "../../../src/core/explore/findings.js";
import type { ActionMark, ActionOutcome, Finding } from "../../../src/core/explore/findings.js";
import type { Decision } from "../../../src/core/discover/decision.js";
import type { NetworkRequest } from "../../../src/core/types.js";

const click: Decision = { action: "click", text: "Buy" };
const typing: Decision = { action: "type", text: "Search", value: "beans" };

const mark = (over: Partial<ActionMark> = {}): ActionMark => ({
  url: "https://shop/cart",
  requestCount: 0,
  consoleCount: 0,
  render: "- [button] Buy",
  ...over,
});

const outcome = (over: Partial<ActionOutcome> = {}): ActionOutcome => ({
  url: "https://shop/cart",
  requests: [],
  console: [],
  render: "- [button] Buy",
  ...over,
});

const req = (status: number, over: Partial<NetworkRequest> = {}): NetworkRequest => ({
  method: "GET",
  url: "https://shop/api/items",
  status,
  ...over,
});

describe("deriveActionFindings — failed-request", () => {
  it("reports a request the action fired that failed", () => {
    const found = deriveActionFindings(mark(), outcome({ requests: [req(500)], render: "x" }), click, 1);
    expect(found).toEqual([
      expect.objectContaining({ kind: "failed-request", severity: "error", stepIndex: 1 }),
    ]);
    expect(found[0]!.detail).toContain("GET https://shop/api/items → 500");
  });

  it("ignores requests that predate the action (before the mark)", () => {
    const found = deriveActionFindings(
      mark({ requestCount: 1 }),
      outcome({ requests: [req(500)], render: "x" }),
      click,
      1,
    );
    expect(found).toEqual([]);
  });

  it("ignores benign failures — built-in (favicon) and product-marked", () => {
    const requests = [
      req(404, { url: "https://shop/favicon.ico" }),
      req(500, { url: "https://analytics.example/collect" }),
    ];
    const found = deriveActionFindings(
      mark(),
      outcome({ requests, render: "x" }),
      click,
      1,
      { benign: ["analytics.example"] },
    );
    expect(found).toEqual([]);
  });

  it("ignores a failure the app recovered from (retry answered under 400)", () => {
    const requests = [
      req(401, { method: "POST", url: "https://shop/api/login" }),
      req(200, { method: "POST", url: "https://shop/api/login" }),
    ];
    expect(deriveActionFindings(mark(), outcome({ requests, render: "x" }), click, 1)).toEqual([]);
  });

  it("ignores in-flight requests (status 0)", () => {
    expect(deriveActionFindings(mark(), outcome({ requests: [req(0)], render: "x" }), click, 1)).toEqual([]);
  });
});

describe("deriveActionFindings — console-error", () => {
  it("reports a console error the action surfaced", () => {
    const found = deriveActionFindings(
      mark(),
      outcome({ console: [{ type: "error", text: "TypeError: order is null" }], render: "x" }),
      click,
      2,
    );
    expect(found).toEqual([
      expect.objectContaining({ kind: "console-error", severity: "error", stepIndex: 2 }),
    ]);
  });

  it("ignores pre-existing messages, non-errors, and benign console noise", () => {
    const console = [
      { type: "error", text: "old error" },
      { type: "warning", text: "deprecation" },
      { type: "error", text: "[i18n] missing key" },
    ];
    const found = deriveActionFindings(
      mark({ consoleCount: 1 }),
      outcome({ console, render: "x" }),
      click,
      1,
      { benignConsole: ["[i18n]"] },
    );
    expect(found).toEqual([]);
  });
});

describe("deriveActionFindings — dead-action", () => {
  it("flags a click that changed nothing — no navigation, no request, no render change", () => {
    const found = deriveActionFindings(mark(), outcome(), click, 3);
    expect(found).toEqual([
      expect.objectContaining({ kind: "dead-action", severity: "warn", stepIndex: 3 }),
    ]);
  });

  it("stays silent when the click navigated (even query-only moves count via render change)", () => {
    expect(deriveActionFindings(mark(), outcome({ url: "https://shop/done" }), click, 1)).toEqual([]);
  });

  it("stays silent when the click fired a request or changed the page", () => {
    expect(deriveActionFindings(mark(), outcome({ requests: [req(200)] }), click, 1)).toEqual([]);
    expect(deriveActionFindings(mark(), outcome({ render: "- [button] Bought" }), click, 1)).toEqual([]);
  });

  it("only indicts effectful actions — a type/scroll changing nothing is normal", () => {
    expect(deriveActionFindings(mark(), outcome(), typing, 1)).toEqual([]);
    expect(deriveActionFindings(mark(), outcome(), { action: "scroll" }, 1)).toEqual([]);
  });

  it("needs both URLs to call an action dead — an unknown before/after is not evidence", () => {
    expect(deriveActionFindings(mark({ url: undefined }), outcome(), click, 1)).toEqual([]);
  });
});

describe("deriveActionFindings — slow-settle", () => {
  it("flags a settle at/above the threshold and respects a custom one", () => {
    const slow = deriveActionFindings(mark(), outcome({ settleMs: 5_000, render: "x" }), click, 1);
    expect(slow).toEqual([expect.objectContaining({ kind: "slow-settle", severity: "warn" })]);
    const custom = deriveActionFindings(
      mark(),
      outcome({ settleMs: 1_500, render: "x" }),
      click,
      1,
      { slowSettleMs: 1_000 },
    );
    expect(custom).toHaveLength(1);
  });

  it("stays silent under the threshold or when untimed", () => {
    expect(deriveActionFindings(mark(), outcome({ settleMs: 800, render: "x" }), click, 1)).toEqual([]);
    expect(deriveActionFindings(mark(), outcome({ render: "x" }), click, 1)).toEqual([]);
  });
});

describe("dedupeFindings", () => {
  const finding = (key: string, detail = key): Finding => ({
    kind: "console-error",
    severity: "error",
    detail,
    key,
    stepIndex: 0,
  });

  it("collapses same-key repeats into the first occurrence with a count", () => {
    const deduped = dedupeFindings([finding("a", "first"), finding("b"), finding("a", "second")]);
    expect(deduped).toEqual([
      expect.objectContaining({ key: "a", detail: "first", occurrences: 2 }),
      expect.objectContaining({ key: "b" }),
    ]);
    expect(deduped[1]!.occurrences).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const input = [finding("a"), finding("a")];
    dedupeFindings(input);
    expect(input[0]!.occurrences).toBeUndefined();
  });
});
