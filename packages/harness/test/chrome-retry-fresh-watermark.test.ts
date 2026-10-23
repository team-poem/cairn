// file: packages/harness/test/chrome-retry-fresh-watermark.test.ts
import { expect, test } from "vitest";
import { ChromeDevToolsDriver, parseSnapshotRows } from "../src/adapters/drivers/chrome.js";
import { createHostOwnedRootScope } from "../src/adapters/drivers/host-owned-roots.js";

function changingRetrySelect(verboseOnlyControl: boolean, ownership?: "empty" | "active") {
  const driver = new ChromeDevToolsDriver({ promoteClickables: false,
    ...(ownership ? { hostOwnedRoots: createHostOwnedRootScope() } : {}),
  });
  const clicks: string[] = [];
  const calls: string[] = [];
  const control = 'uid=1_1 combobox "Size"';
  const native = 'uid=1_2 option "Medium"';
  const popup = 'uid=1_3 option "Medium"';
  let changed = false;
  let opened = false;
  let mapped = new Set<string>();
  (driver as unknown as { call: unknown }).call = async (name: string, args: Record<string, unknown> = {}) => {
    calls.push(name === "take_snapshot" ? `${name}:${args.verbose ? "verbose" : "compact"}` : name);
    if (name === "take_snapshot") {
      // A page update lands while the initial compact miss waits for its first retry.
      const raw = !changed ? 'uid=1_0 heading "Form"'
        : args.verbose ? [control, native, popup].join("\n")
        : opened ? [control, native, popup].join("\n")
        : [native, ...(verboseOnlyControl ? [] : [control])].join("\n");
      // Capture completed before the unrelated update; the next capture sees the new state.
      changed = true;
      // Real MCP snapshots remove omitted UIDs from their current dispatch map.
      mapped = new Set(parseSnapshotRows(raw).map(row => row.uid));
      return raw;
    }
    if (name === "list_pages") return "0: https://example.test/form [selected]";
    if (name === "select_page") return "";
    if (name === "evaluate_script") {
      for (const uid of (args.args ?? []) as string[]) {
        if (!mapped.has(uid)) throw new Error(`UID ${uid} was omitted from the latest snapshot`);
      }
      return JSON.stringify({ tag: "BUTTON", stamp: "document:1", active: ownership === "active" ? 1 : 0,
        unsupported: false, allowed: true, excluded: ((args.args ?? []) as string[]).map(() => false) });
    }
    if (name === "click") {
      if (!mapped.has(String(args.uid))) throw new Error(`UID ${args.uid} was omitted from the latest snapshot`);
      clicks.push(String(args.uid));
      if (args.uid === "1_1") opened = true;
      return "";
    }
    throw new Error(`unexpected MCP call ${name}`);
  };
  driver.settle = async () => {};
  return { driver, clicks, calls };
}

test.each([undefined, "empty", "active"] as const)("chromeRetryFreshSelectWatermark (%s scope): an unrelated native option arriving during a successful retry is excluded from the dropdown's new options", async ownership => {
  const { driver, clicks } = changingRetrySelect(false, ownership);
  await driver.select({ text: "Size", role: "combobox" }, "Medium");
  expect(clicks).toEqual(["1_1", "1_3"]);
});

test.each([undefined, "empty", "active"] as const)("chromeRetryFreshWatermarkRetainsDispatch (%s scope): refreshing the before-open watermark preserves a control omitted from compact MCP mappings", async ownership => {
  const { driver, clicks } = changingRetrySelect(true, ownership);
  await driver.select({ text: "Size", role: "combobox" }, "Medium");
  expect(clicks).toEqual(["1_1", "1_3"]);
});
