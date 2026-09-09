import { expect, test } from "vitest";
import { ChromeDevToolsDriver } from "../src/adapters/drivers/chrome.js";
import type { PageElement, Target } from "../src/core/types.js";

type Observed = PageElement & { ref?: string; inActivePopup?: boolean; occluded?: boolean };
type ObservingChrome = ChromeDevToolsDriver & {
  snapshot(options?: { perception?: boolean }): Promise<Observed[]>;
  locateRef(ref: string): Promise<Target>;
  click(target: Target, ref?: string): Promise<void>;
};

function fixture() {
  const driver = new ChromeDevToolsDriver({ promoteClickables: false }) as ObservingChrome;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const state = {
    snapshot: 'uid=1_1 button "Save"\nuid=1_2 button "Save"',
    page: '0: https://example.test/form [selected]',
    connected: true,
    rejectClick: false,
    facts: {} as Record<string, unknown>,
  };
  (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });
    if (name === "take_snapshot") return state.snapshot;
    if (name === "list_pages") return state.page;
    if (name === "evaluate_script") {
      if (String(args.function).includes("connected:")) return JSON.stringify({ connected: state.connected });
      if (String(args.function).includes("const ids =")) return JSON.stringify(Object.fromEntries(
        (args.args as string[]).map(uid => [uid, { referenceReady: true, ...(state.facts[uid] as object ?? {}) }]),
      ));
      return JSON.stringify(state.facts);
    }
    if (name === "click" && state.rejectClick) throw new Error("Node is detached from document");
    return "";
  };
  return { driver, calls, state };
}

async function refOf(driver: ObservingChrome, index = 1) {
  const rows = await driver.snapshot({ perception: true });
  expect(rows[index]?.ref).toBeTypeOf("string");
  return rows[index]!.ref!;
}

test("chromeObservationExactNode: a duplicate ref enriches and clicks only its captured UID", async () => {
  const { driver, calls } = fixture();
  const ref = await refOf(driver);
  const target = await driver.locateRef(ref);
  expect(target).toEqual({ text: "Save", role: "button", index: 1, nth: 1 });
  await driver.click(target, ref);
  expect(calls.filter(c => c.name === "click")).toEqual([{ name: "click", args: { uid: "1_2" } }]);
  expect(calls.filter(c => c.name === "take_snapshot")).toHaveLength(1);
  expect(JSON.stringify(target)).not.toContain(ref);
  await expect(driver.locateRef(ref)).rejects.toThrow(/ref|expired/i);
});

test("chromeObservationLifetime: recapture, foreign driver, navigation and close expire refs", async () => {
  const { driver, calls } = fixture();
  const old = await refOf(driver);
  const current = await refOf(driver);
  expect(current).not.toBe(old);
  await expect(driver.locateRef(old)).rejects.toThrow(/ref|expired/i);
  const other = fixture().driver;
  await refOf(other);
  await expect(other.locateRef(current)).rejects.toThrow(/ref|expired/i);
  await driver.goto("https://example.test/next");
  await expect(driver.click({ text: "Save" }, current)).rejects.toThrow(/ref|expired/i);
  const closing = await refOf(driver);
  await driver.close();
  await expect(driver.click({ text: "Save" }, closing)).rejects.toThrow(/closed|ref|expired/i);
  expect(calls.filter(c => c.name === "click")).toEqual([]);
});

test("chromeObservationContinuity: detached nodes and external page changes never fall back by name", async () => {
  for (const change of ["detached", "tab", "url", "unmeasured"] as const) {
    const { driver, calls, state } = fixture();
    const ref = await refOf(driver);
    if (change === "detached") state.connected = false;
    if (change === "tab") state.page = '1: https://example.test/form [selected]';
    if (change === "url") state.page = '0: https://example.test/next [selected]';
    if (change === "unmeasured") state.page = "";
    await expect(driver.click({ text: "Save" }, ref)).rejects.toThrow(/ref|expired|detached|continuity/i);
    expect(calls.filter(c => c.name === "click")).toEqual([]);
    expect(calls.filter(c => c.name === "take_snapshot")).toHaveLength(1);
  }
});

test("chromeObservationDispatchRace: an MCP detach error consumes the ref without retrying", async () => {
  const { driver, calls, state } = fixture();
  const ref = await refOf(driver);
  state.rejectClick = true;
  await expect(driver.click({ text: "Save" }, ref)).rejects.toThrow(/detached/i);
  await expect(driver.click({ text: "Save" }, ref)).rejects.toThrow(/ref|expired/i);
  expect(calls.filter(c => c.name === "click")).toHaveLength(1);
});

test("chromeObservationLegacy: ordinary snapshots retain their shape and omit transient fields", async () => {
  const { driver, calls } = fixture();
  expect(await driver.snapshot()).toEqual([{ role: "button", name: "Save" }, { role: "button", name: "Save" }]);
  expect(calls.map(c => c.name)).toEqual(["take_snapshot"]);
});

test("chromeObservationFacts: facts stay attached to exact nodes without changing roles", async () => {
  const { driver, state } = fixture();
  state.facts = { "1_1": { occluded: true }, "1_2": { inActivePopup: true, occluded: false, role: "link", ref: "forged" } };
  const rows = await driver.snapshot({ perception: true });
  expect(rows[0]).toMatchObject({ role: "button", name: "Save", occluded: true });
  expect(rows[1]).toMatchObject({ role: "button", name: "Save", inActivePopup: true, occluded: false });
  expect(rows[1]!.ref).not.toBe("forged");
});

test("chromeObservationUnknownPage: incomplete page identity does not offer unsafe references", async () => {
  const { driver, state } = fixture();
  state.page = "";
  const rows = await driver.snapshot({ perception: true });
  expect(rows).toHaveLength(2);
  expect(rows.every(row => row.ref === undefined)).toBe(true);
});

test("chromeObservationFullCapture: request the full tree and exclude synthetic duplicate InlineTextBox UIDs", async () => {
  const { driver, calls, state } = fixture();
  state.snapshot = 'uid=1_1 button "Save"\n  uid=1_2 StaticText "Save"\n    uid=1_3 InlineTextBox "Save"\nuid=1_4 option "Personal"\n  uid=1_5 StaticText "Personal"\n    uid=1_3 InlineTextBox "Personal"';
  const rows = await driver.snapshot({ perception: true });
  expect(calls.find(c => c.name === "take_snapshot")?.args).toEqual({ verbose: true });
  expect(rows.some(row => row.role === "InlineTextBox")).toBe(false);
  expect(new Set(rows.map(row => row.ref)).size).toBe(rows.length);
});

test("chromeObservationBatchIsolation: an unsupported UID cannot erase other nodes' popup facts", async () => {
  const { driver } = fixture();
  const original = (driver as unknown as { call: (name: string, args?: Record<string, unknown>) => Promise<string> }).call;
  (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
    if (name === "evaluate_script" && String(args.function).includes("const ids =")) {
      const ids = args.args as string[];
      if (ids.includes("1_1")) throw new Error("Elements from different frames cannot be evaluated together");
      return JSON.stringify({ "1_2": { inActivePopup: true, referenceReady: true } });
    }
    return original(name, args);
  };
  const rows = await driver.snapshot({ perception: true });
  expect(rows[0]?.inActivePopup).toBeUndefined();
  expect(rows[1]?.inActivePopup).toBe(true);
  expect(rows.every(row => row.ref === undefined)).toBe(true);
});

test("chromeObservationReplay: frozen option locators can recover nodes omitted by compact MCP snapshots", async () => {
  const { driver, calls } = fixture();
  const original = (driver as unknown as { call: (name: string, args?: Record<string, unknown>) => Promise<string> }).call;
  (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
    if (name === "take_snapshot") return args.verbose ? 'uid=2_1 option "Personal"' : 'uid=1_0 listbox orientation="vertical"';
    return original(name, args);
  };
  await driver.click({ text: "Personal", role: "option", index: 0 });
  expect(calls.filter(c => c.name === "click")).toEqual([{ name: "click", args: { uid: "2_1" } }]);
});
