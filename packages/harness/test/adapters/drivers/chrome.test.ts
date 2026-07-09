import { describe, expect, it } from "vitest";
import {
  ChromeDevToolsDriver,
  describeResolutionMiss,
  findUidByName,
  followableTab,
  isOpenDialog,
  parseSnapshotRows,
  resolveTargetUid,
  isNavigation,
  normalizeUrl,
  parseConsole,
  parseElements,
  parseNetwork,
  parsePageEntries,
  parsePageIds,
  parseSelectedUrl,
  selectorProbeScript,
} from "../../../src/adapters/drivers/chrome.js";

/** Driver whose MCP layer is a scripted stub — records calls, returns canned text per tool. */
function stubbedDriver(responses: Record<string, string | ((args: Record<string, unknown>) => string)>) {
  const driver = new ChromeDevToolsDriver();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  (driver as unknown as { call: unknown }).call = async (
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    calls.push({ name, args });
    const r = responses[name];
    if (r === undefined) return "";
    return typeof r === "function" ? r(args) : r;
  };
  return { driver, calls };
}

// Sample text mirrors real chrome-devtools-mcp output observed during dogfooding.

const SNAPSHOT = `uid=1_0 RootWebArea "Example Domain" url="https://example.com/"
  uid=1_1 heading "Example Domain" level="1"
  uid=1_2 StaticText "This domain is for use in documentation examples."
  uid=1_3 link "Learn more" url="https://iana.org/domains/example"
    uid=1_4 StaticText "Learn more"`;

describe("parseElements", () => {
  it("extracts role + name for named rows", () => {
    expect(parseElements(SNAPSHOT)).toEqual([
      { role: "RootWebArea", name: "Example Domain" },
      { role: "heading", name: "Example Domain" },
      { role: "StaticText", name: "This domain is for use in documentation examples." },
      { role: "link", name: "Learn more" },
      { role: "StaticText", name: "Learn more" },
    ]);
  });

  it("parses form state from the attribute tail — real formatter tokens (#93)", () => {
    const snap = [
      `uid=2_1 checkbox "Terms" checkable checked`,
      `uid=2_2 checkbox "Marketing" checkable`,
      `uid=2_3 checkbox "Partial" checkable checked="mixed"`,
      `uid=2_4 button "Pay" disableable disabled`,
      `uid=2_5 textbox "Email" value="a@b.com"`,
      `uid=2_6 button "I have checked the box"`, // state words inside a NAME must not match
    ].join("\n");
    expect(parseElements(snap)).toEqual([
      { role: "checkbox", name: "Terms", checked: true },
      { role: "checkbox", name: "Marketing" },
      { role: "checkbox", name: "Partial", checked: "mixed" },
      { role: "button", name: "Pay", disabled: true },
      { role: "textbox", name: "Email", value: "a@b.com" },
      { role: "button", name: "I have checked the box" },
    ]);
  });
});

describe("findUidByName", () => {
  it("returns the first uid whose accessible name matches (case-insensitive)", () => {
    expect(findUidByName(SNAPSHOT, "learn more")).toBe("1_3");
  });

  it("prefers an exact name over a substring match", () => {
    const snap = `uid=2_1 link "Add to Cart"\nuid=2_2 button "Cart"`;
    expect(findUidByName(snap, "Cart")).toBe("2_2"); // not 2_1 "Add to Cart"
  });

  it("never matches a bare url= attribute as a name", () => {
    const snap = `uid=3_1 link url="https://shop.com/cart"\nuid=3_2 link "Home"`;
    expect(findUidByName(snap, "shop.com/cart")).toBeUndefined();
  });
  it("returns undefined when nothing matches", () => {
    expect(findUidByName(SNAPSHOT, "checkout")).toBeUndefined();
  });
});

describe("resolveTargetUid — multi-locator", () => {
  const v1 = `uid=1_1 textbox "Username"\nuid=1_2 button "Log in"`;
  // a UI rename: same roles/positions, different visible names
  const v2 = `uid=2_1 textbox "Account"\nuid=2_2 button "Sign in"`;

  it("resolves by accessible name when it still matches", () => {
    expect(resolveTargetUid(parseSnapshotRows(v1), { text: "Log in", role: "button", index: 0 })).toBe("1_2");
  });

  it("survives a rename via role + structural index (no LLM)", () => {
    // "Log in" no longer exists on v2; role=button index=0 still finds the (renamed) login button
    expect(resolveTargetUid(parseSnapshotRows(v2), { text: "Log in", role: "button", index: 0 })).toBe("2_2");
    expect(resolveTargetUid(parseSnapshotRows(v2), { text: "Username", role: "textbox", index: 0 })).toBe("2_1");
  });

  it("returns undefined when neither name nor role+index resolves", () => {
    expect(resolveTargetUid(parseSnapshotRows(v2), { text: "Log in" })).toBeUndefined();
  });

  it("refuses an ambiguous positional fallback so a reorder can't silently mis-select (P3)", () => {
    // The frozen name is gone and several same-role candidates remain → guessing by index risks the
    // wrong one after a reorder. Yield nothing so self-heal picks by intent.
    const rows = `uid=3_1 button "Search"\nuid=3_2 button "Profile"\nuid=3_3 button "Help"`;
    expect(resolveTargetUid(parseSnapshotRows(rows), { text: "Log in", role: "button", index: 0 })).toBeUndefined();
  });

  it("still honors a deliberate positional target (role+index, no text)", () => {
    const rows = `uid=3_1 button "Search"\nuid=3_2 button "Profile"`;
    expect(resolveTargetUid(parseSnapshotRows(rows), { role: "button", index: 1 })).toBe("3_2");
  });

  it("refuses an ambiguous substring match instead of guessing the first (M1)", () => {
    // No exact "Add" — two controls contain it; picking the first would silently mis-click.
    const rows = `uid=4_1 button "Add to cart"\nuid=4_2 button "Add to wishlist"`;
    expect(resolveTargetUid(parseSnapshotRows(rows), { text: "Add" })).toBeUndefined();
    // a single substring match still resolves
    expect(resolveTargetUid(parseSnapshotRows(rows), { text: "wishlist" })).toBe("4_2");
  });
});

describe("parseNetwork", () => {
  it("parses reqid/method/url/status rows and ignores headers", () => {
    const text = `## Network requests
Showing 1-2 of 2 (Page 1 of 1).
reqid=5 GET https://www.iana.org/help/example-domains [200]
reqid=6 GET https://www.iana.org/static/iana_website.css [503]`;
    expect(parseNetwork(text)).toEqual([
      { method: "GET", url: "https://www.iana.org/help/example-domains", status: 200 },
      { method: "GET", url: "https://www.iana.org/static/iana_website.css", status: 503 },
    ]);
  });

  it("parses an in-flight [pending] row as status 0 instead of dropping it (#97)", () => {
    const text = `reqid=7 POST https://app/api/orders [pending]
reqid=8 GET https://app/api/me [200]`;
    expect(parseNetwork(text)).toEqual([
      { method: "POST", url: "https://app/api/orders", status: 0 },
      { method: "GET", url: "https://app/api/me", status: 200 },
    ]);
  });
});

describe("parseSelectedUrl", () => {
  it("reads the url of the selected page", () => {
    const text = `## Pages
1: about:blank
2: Example Domain (https://example.com/) [selected]`;
    expect(parseSelectedUrl(text)).toBe("https://example.com/");
  });
  it("handles a bare (parenthesis-less) selected entry", () => {
    expect(parseSelectedUrl(`1: about:blank [selected]`)).toBe("about:blank");
  });
  it("returns undefined when no page is selected", () => {
    expect(parseSelectedUrl(`1: about:blank`)).toBeUndefined();
  });
});

describe("isNavigation", () => {
  it("ignores a trailing-slash-only difference", () => {
    expect(isNavigation("https://example.com", "https://example.com/")).toBe(false);
  });
  it("detects a real navigation", () => {
    expect(isNavigation("https://example.com", "https://www.iana.org/help/example-domains")).toBe(true);
  });
  it("treats a first navigation (no initial url) as navigation", () => {
    expect(isNavigation(undefined, "https://example.com/")).toBe(true);
  });
  it("normalizeUrl drops trailing slash and hash", () => {
    expect(normalizeUrl("https://x.com/path/#frag")).toBe("https://x.com/path");
  });
});

describe("parsePageIds", () => {
  it("reads page ids and ignores other lines", () => {
    const text = `## Pages\n4: Example (https://example.com/) [selected]\n7: Detail (https://example.com/p/3)`;
    expect(parsePageIds(text)).toEqual([4, 7]);
  });
});

describe("parseConsole", () => {
  it("parses the real `msgid=N [type] text (M args)` format and strips the args suffix", () => {
    const text = `## Console messages
Showing 1-3 of 3 (Page 1 of 1).
msgid=1 [error] TypeError: orders is null (1 args)
msgid=2 [warn] slow request (1 args)
msgid=3 [log] hydrated (1 args)`;
    expect(parseConsole(text)).toEqual([
      { type: "error", text: "TypeError: orders is null" },
      { type: "warn", text: "slow request" },
      { type: "log", text: "hydrated" },
    ]);
  });
  it("ignores header/non-message lines", () => {
    expect(parseConsole(`## Console messages\nShowing 0-0 of 0`)).toEqual([]);
  });
});

describe("isOpenDialog", () => {
  it("detects the chrome-devtools-mcp open-dialog error (verified shape)", () => {
    const err = new Error(
      "# Open dialog\nconfirm: proceed?\nCall handle_dialog to handle it before continuing.",
    );
    expect(isOpenDialog(err)).toBe(true);
  });

  it("is false for an ordinary failure", () => {
    expect(isOpenDialog(new Error("no element matching"))).toBe(false);
    expect(isOpenDialog("plain string")).toBe(false);
  });
});

describe("snapshot freshness (#85)", () => {
  it("snapshot() re-fetches every call so a waitFor poll sees new content", async () => {
    const { driver, calls } = stubbedDriver({ take_snapshot: 'uid=1_1 button "Go"' });
    await driver.snapshot();
    await driver.snapshot();
    expect(calls.filter((c) => c.name === "take_snapshot")).toHaveLength(2);
  });

  it("locate() still reuses the snapshot taken in the same turn", async () => {
    const { driver, calls } = stubbedDriver({ take_snapshot: 'uid=1_1 button "Go"' });
    await driver.snapshot();
    await driver.locate({ text: "Go" });
    expect(calls.filter((c) => c.name === "take_snapshot")).toHaveLength(1);
  });
});

describe("Target.selector resolution (#91)", () => {
  it("resolves a selector by probing its accessible name and joining to the snapshot", async () => {
    const { driver, calls } = stubbedDriver({
      take_snapshot: 'uid=2_1 button "Cancel"\nuid=2_3 button "Submit order"',
      evaluate_script: 'Script ran on page and returned:\n```json\n{"name":"Submit order"}\n```',
      list_pages: "",
    });
    await driver.click({ selector: "#buy" });
    const click = calls.find((c) => c.name === "click");
    expect(click?.args.uid).toBe("2_3");
  });

  it("falls through to text locators when the selector matches nothing", async () => {
    const { driver, calls } = stubbedDriver({
      take_snapshot: 'uid=2_1 button "Cancel"',
      evaluate_script: "Script ran on page and returned:\n```json\nnull\n```",
      list_pages: "",
    });
    await driver.click({ selector: "#gone", text: "Cancel" });
    expect(calls.find((c) => c.name === "click")?.args.uid).toBe("2_1");
  });

  it("selectorProbeScript embeds the selector as a JSON string literal", () => {
    expect(selectorProbeScript('a[href="/x"]')).toContain('document.querySelector("a[href=\\"/x\\"]")');
  });
});

describe("followNewTab guard + verb coverage (#89)", () => {
  it("parsePageEntries reads url-ful and url-less pages", () => {
    const text = `1: about:blank\n2: Example Domain (https://example.com/) [selected]\n3: Untitled`;
    expect(parsePageEntries(text)).toEqual([
      { id: 1, url: "about:blank" },
      { id: 2, url: "https://example.com/" },
      { id: 3, url: undefined },
    ]);
  });

  it("does not follow a fresh about:blank or url-less tab", () => {
    const entries = parsePageEntries(`1: app (https://app/) [selected]\n2: about:blank\n3: Untitled`);
    expect(followableTab(entries, new Set([1]))).toBeUndefined();
  });

  it("follows the newest fresh real page", () => {
    const entries = parsePageEntries(`1: app (https://app/)\n2: pop (https://pay/) [selected]`);
    expect(followableTab(entries, new Set([1]))).toBe(2);
  });

  it("pressKey follows a new real tab (coverage beyond click)", async () => {
    const { driver, calls } = stubbedDriver({
      press_key: "",
      list_pages: "1: app (https://app/)\n2: receipt (https://app/receipt)",
      take_snapshot: "",
    });
    await driver.pressKey("Enter");
    expect(calls.find((c) => c.name === "select_page")?.args.pageId).toBe(2);
  });
});

describe("session lifecycle guards (#98, #88)", () => {
  it("rejects any call after close() — a closed driver is not reusable", async () => {
    const d = new ChromeDevToolsDriver();
    await d.close();
    await expect(d.goto("https://example.com")).rejects.toThrow(/driver closed/);
  });

  it("fails fast when the transport died mid-run instead of reconnecting blank", async () => {
    const d = new ChromeDevToolsDriver();
    (d as unknown as { crashed: boolean }).crashed = true;
    await expect(d.goto("https://example.com")).rejects.toThrow(/mid-run/);
  });
});

describe("resolveTargetUid — nth among same-named elements (#92)", () => {
  // The list-UI repro: every row's action button carries the same accessible name.
  const LIST = `uid=5_0 button "Accept"
  uid=5_1 link "Details"
  uid=5_2 button "Accept"
  uid=5_3 button "Decline"
  uid=5_4 button "Accept"`;
  const rows = parseSnapshotRows(LIST);

  it("addresses the Nth name match (0-based, same convention as index)", () => {
    expect(resolveTargetUid(rows, { text: "Accept", role: "button", nth: 0 })).toBe("5_0");
    expect(resolveTargetUid(rows, { text: "Accept", role: "button", nth: 1 })).toBe("5_2");
    expect(resolveTargetUid(rows, { text: "Accept", role: "button", nth: 2 })).toBe("5_4");
  });

  it("counts only elements matching the role constraint", () => {
    const mixed = parseSnapshotRows(`uid=6_0 link "Accept"\nuid=6_1 button "Accept"\nuid=6_2 button "Accept"`);
    expect(resolveTargetUid(mixed, { text: "Accept", role: "button", nth: 1 })).toBe("6_2");
    expect(resolveTargetUid(mixed, { text: "Accept", nth: 1 })).toBe("6_1"); // role-less: every match counts
  });

  it("yields nothing when nth is out of range (the list shrank) instead of guessing", () => {
    expect(resolveTargetUid(rows, { text: "Accept", role: "button", nth: 3 })).toBeUndefined();
  });

  it("does not regress P3: an out-of-range nth never falls through to a positional guess", () => {
    expect(resolveTargetUid(rows, { text: "Accept", role: "button", index: 0, nth: 9 })).toBeUndefined();
  });

  it("refuses same-role duplicates without nth instead of guessing the first (#127)", () => {
    expect(resolveTargetUid(rows, { text: "Accept", role: "button" })).toBeUndefined();
  });

  it("applies nth to the substring pool when no exact name matches (M1 stays for nth-less targets)", () => {
    const subs = parseSnapshotRows(`uid=7_0 button "Add to cart"\nuid=7_1 button "Add to wishlist"`);
    expect(resolveTargetUid(subs, { text: "Add", nth: 1 })).toBe("7_1");
    expect(resolveTargetUid(subs, { text: "Add" })).toBeUndefined();
  });
});

describe("locate — nth enrichment for duplicate names (#92)", () => {
  // Only take_snapshot is needed for locate(); everything else is inert.
  function locatingDriver(snapshot: string): ChromeDevToolsDriver {
    const driver = new ChromeDevToolsDriver();
    (driver as unknown as { call: (name: string, args?: Record<string, unknown>) => Promise<string> }).call =
      async (name) => (name === "take_snapshot" ? snapshot : "");
    return driver;
  }
  const LIST = `uid=5_0 button "Accept"\nuid=5_2 button "Accept"\nuid=5_4 button "Accept"`;

  it("nth-less duplicates no longer enrich — resolution refuses the guess upstream (#127)", async () => {
    const t = await locatingDriver(LIST).locate({ text: "Accept" });
    expect(t).toEqual({ text: "Accept" }); // unenriched; execution will fail with the ambiguity message
  });

  it("keeps an author's nth and derives the structural index from the element it resolves to", async () => {
    const t = await locatingDriver(LIST).locate({ text: "Accept", nth: 2 });
    expect(t).toEqual({ text: "Accept", role: "button", index: 2, nth: 2 });
  });

  it("adds no nth when the name is unique", async () => {
    const t = await locatingDriver(`uid=1_1 button "Buy"`).locate({ text: "Buy" });
    expect(t).toEqual({ text: "Buy", role: "button", index: 0 });
    expect("nth" in t).toBe(false);
  });
});

describe("duplicate exact names (#127)", () => {
  const dup = `uid=5_1 link "Log in"\nuid=5_2 button "Log in"\nuid=5_3 button "Log in"`;

  it("refuses to guess among several exact matches without nth", () => {
    expect(resolveTargetUid(parseSnapshotRows(dup), { text: "Log in" })).toBeUndefined();
  });

  it("role alone resolves when it narrows to one", () => {
    expect(resolveTargetUid(parseSnapshotRows(dup), { text: "Log in", role: "link" })).toBe("5_1");
  });

  it("role + nth addresses the Nth same-named element", () => {
    expect(resolveTargetUid(parseSnapshotRows(dup), { text: "Log in", role: "button", nth: 1 })).toBe("5_3");
  });

  it("a single exact match still resolves without nth", () => {
    const single = `uid=6_1 button "Pay"`;
    expect(resolveTargetUid(parseSnapshotRows(single), { text: "Pay" })).toBe("6_1");
  });

  it("describeResolutionMiss names the ambiguity and the fix", () => {
    const msg = describeResolutionMiss(parseSnapshotRows(dup), { text: "Log in" });
    expect(msg).toContain('3 elements named "Log in"');
    expect(msg).toContain('"nth"');
  });

  it("describeResolutionMiss stays generic for a true miss", () => {
    expect(describeResolutionMiss(parseSnapshotRows(dup), { text: "Checkout" })).toContain("no element matching");
  });
});

describe("select — native fast-path vs custom dropdown (#: select-aria-native)", () => {
  const nativeSelect = 'Script ran on page and returned:\n```json\n{"tag":"SELECT"}\n```';
  const customButton = 'Script ran on page and returned:\n```json\n{"tag":"BUTTON"}\n```';

  it("drives a real native <select> with fill", async () => {
    const { driver, calls } = stubbedDriver({
      take_snapshot: 'uid=3_1 combobox "Size"',
      evaluate_script: nativeSelect,
    });
    (driver as unknown as { settle: () => Promise<void> }).settle = async () => {};
    await driver.select({ text: "Size" }, "Medium");
    expect(calls.find((c) => c.name === "fill")?.args).toEqual({ uid: "3_1", value: "Medium" });
  });

  it("opens a custom ARIA dropdown and clicks the matching option (watermark-scoped, never fill)", async () => {
    // The combobox is always present; its options render only after the open-click. A NATIVE
    // <select>'s options ("Small"/"Medium") are always in the tree — the watermark must not let
    // the custom pick mismatch them.
    let opened = false;
    const closed = 'uid=1 combobox "Size"\nuid=9 option "Medium"'; // uid=9 = a native select's option, pre-existing
    const open = closed + '\nuid=2 listbox "opts"\nuid=3 option "Small"\nuid=4 option "Medium"';
    const { driver, calls } = stubbedDriver({
      take_snapshot: () => (opened ? open : closed),
      evaluate_script: customButton,
      click: (args) => (args.uid === "1" ? ((opened = true), "") : ""),
    });
    (driver as unknown as { settle: () => Promise<void> }).settle = async () => {};
    await driver.select({ text: "Size" }, "Medium");
    const clicks = calls.filter((c) => c.name === "click");
    expect(clicks[0]?.args.uid).toBe("1"); // opened the combobox
    expect(clicks[1]?.args.uid).toBe("4"); // the fresh option, not the pre-existing uid=9
    expect(calls.some((c) => c.name === "fill")).toBe(false); // never no-ops a fill on a custom dropdown
  });

  it("throws when no matching option appears after opening (fail-closed)", async () => {
    const { driver, calls } = stubbedDriver({
      take_snapshot: 'uid=1 combobox "Size"', // opening reveals nothing
      evaluate_script: customButton,
    });
    (driver as unknown as { settle: () => Promise<void> }).settle = async () => {};
    await expect(driver.select({ text: "Size" }, "Medium")).rejects.toThrow(/no matching option/);
    expect(calls.some((c) => c.name === "fill")).toBe(false);
  });
});
