import { expect, test } from "vitest";
import { ChromeDevToolsDriver } from "../src/adapters/drivers/chrome.js";
import type { ResourceKeyObservation } from "../src/core/selected-item-evidence.js";

/** Exercise the real dispatch/dialog/tab-follow order, replacing only the protocol transport. */
function setup(options: { popup?: boolean; popupUrl?: string; unknownPages?: boolean; unknownBefore?: boolean; clickError?: string;
  readFailure?: boolean; selectFailure?: boolean; attached?: boolean; existingPeer?: boolean } = {}) {
  const driver = new ChromeDevToolsDriver();
  const events: string[] = [];
  const retained = new Set([1]);
  let page = 1;
  let clicked = false;
  const receipt = {
    async finish(): Promise<ResourceKeyObservation> {
      events.push(`read:${page}`);
      if (options.readFailure) throw new Error("receipt read interrupted");
      const available = retained.delete(page);
      return available ? { complete: true, value: "B" } : { complete: false };
    },
    async dispose() { events.push(`dispose:${page}`); retained.delete(page); },
  };
  const collection = { async validate() { events.push("validate"); }, async prepareSelectedItemKey() { return receipt; } };
  const inner = driver as unknown as {
    actionUid: () => Promise<string>;
    collectionObservations: Map<string, unknown>;
    seenPages: Set<number>;
    collectNetwork: () => Promise<void>;
    call: (name: string, args?: Record<string, unknown>) => Promise<string>;
  };
  inner.actionUid = async () => "uid";
  inner.collectionObservations.set("ref", collection);
  if (!options.attached) inner.seenPages.add(1);
  inner.collectNetwork = async () => {};
  inner.call = async (name, args) => {
    events.push(name);
    if (name === "click") clicked = true;
    if (name === "click" && options.clickError) throw new Error(options.clickError);
    if (name === "list_pages") return (clicked ? options.unknownPages : options.unknownBefore) ? "unavailable"
      : `1: https://app/list [selected]${options.existingPeer ? "\n9: https://app/other" : ""}${clicked && options.popup ? `\n2: ${options.popupUrl ?? "https://app/details"}` : ""}`;
    if (name === "select_page") {
      if (options.selectFailure) throw new Error("page selection failed");
      page = Number(args?.pageId);
    }
    return "";
  };
  return { driver, events, retained, run: () => driver.clickWithSelectedItemEvidence({ role: "button", text: "Open" }, "ref",
    { kind: "attribute", scope: "item", attribute: "data-resource-id" }) };
}

test("cleans the source receipt before following a popup and refuses cross-tab evidence", async () => {
  const f = setup({ popup: true });
  expect(await f.run()).toEqual({ complete: false });
  expect(f.retained.size).toBe(0);
  expect(f.events.indexOf("read:1")).toBeLessThan(f.events.indexOf("select_page"));
  expect(f.events.indexOf("dispose:1")).toBeLessThan(f.events.indexOf("select_page"));
  expect(f.events.filter(name => name === "click")).toHaveLength(1);
});

test("keeps a completed same-document receipt without changing the selected tab", async () => {
  const f = setup();
  expect(await f.run()).toEqual({ complete: true, value: "B" });
  expect(f.retained.size).toBe(0);
  expect(f.events).not.toContain("select_page");
});

test("unknown page observation cannot confirm a same-document result", async () => {
  const f = setup({ unknownPages: true });
  expect(await f.run()).toEqual({ complete: false });
  expect(f.retained.size).toBe(0);
});

test("unknown pre-click tab state cannot confirm a same-document result", async () => {
  const f = setup({ unknownBefore: true });
  expect(await f.run()).toEqual({ complete: false });
  expect(f.retained.size).toBe(0);
  expect(f.events.filter(name => name === "click")).toHaveLength(1);
});

test.each(["about:blank", ""])("an initializing popup (%s) cannot confirm same-document evidence", async popupUrl => {
  const f = setup({ popup: true, popupUrl });
  expect(await f.run()).toEqual({ complete: false });
  expect(f.retained.size).toBe(0);
  expect(f.events).not.toContain("select_page");
});

test.each([false, true])("attached drivers do not treat existing tabs as action-created popups (peer=%s)", async existingPeer => {
  const f = setup({ attached: true, existingPeer });
  expect(await f.run()).toEqual({ complete: true, value: "B" });
  expect(f.retained.size).toBe(0);
  expect(f.events).not.toContain("select_page");
});

test("failed popup selection does not reuse the original page's valid receipt", async () => {
  const f = setup({ popup: true, selectFailure: true });
  expect(await f.run()).toEqual({ complete: false });
  expect(f.retained.size).toBe(0);
});

test("a failed receipt read is disposed before following a popup, without retrying the click", async () => {
  const f = setup({ popup: true, readFailure: true });
  expect(await f.run()).toEqual({ complete: false });
  expect(f.retained.size).toBe(0);
  expect(f.events.indexOf("dispose:1")).toBeLessThan(f.events.indexOf("select_page"));
  expect(f.events.filter(name => name === "click")).toHaveLength(1);
});

test("a dispatch failure cleans the source document and never follows or retries", async () => {
  const f = setup({ popup: true, clickError: "dispatch failed" });
  await expect(f.run()).rejects.toThrow("dispatch failed");
  expect(f.retained.size).toBe(0);
  expect(f.events).not.toContain("select_page");
  expect(f.events.filter(name => name === "click")).toHaveLength(1);
});

test("dialog acceptance finishes before receipt cleanup and popup following", async () => {
  const f = setup({ popup: true, clickError: "# Open dialog\nconfirm: proceed?\nCall handle_dialog to handle it before continuing." });
  expect(await f.run()).toEqual({ complete: false });
  expect(f.retained.size).toBe(0);
  expect(f.events.indexOf("handle_dialog")).toBeGreaterThan(f.events.indexOf("click"));
  expect(f.events.indexOf("handle_dialog")).toBeLessThan(f.events.indexOf("read:1"));
  expect(f.events.indexOf("dispose:1")).toBeLessThan(f.events.indexOf("select_page"));
  expect(f.events.filter(name => name === "click")).toHaveLength(1);
});
